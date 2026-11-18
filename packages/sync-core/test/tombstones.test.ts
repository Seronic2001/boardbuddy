import { describe, expect, it } from "vitest";
import { SyncClient } from "../src/client";
import { applyAll, emptyDoc, expiredTombstones, isVisible, type Op } from "../src/doc";
import type { ClientMessage, ServerMessage } from "../src/protocol";
import { Replica } from "../src/replica";
import { InMemoryPersister, LAYER_GONE, Room, SERVER_CLIENT } from "../src/room";

const DAY = 24 * 60 * 60 * 1000;
const TTL = 30 * DAY;

const ts = (wall: number, client = "a~1", counter = 0) => ({ wall, counter, client });
const create = (layer: string, wall: number, client = "a~1"): Op => ({ kind: "create", layer, fields: { x: 0 }, ts: ts(wall, client) });
const set = (layer: string, v: number, wall: number, client = "a~1"): Op => ({ kind: "set", layer, field: "x", v, ts: ts(wall, client) });
const del = (layer: string, wall: number, client = "a~1"): Op => ({ kind: "delete", layer, ts: ts(wall, client) });

describe("expiredTombstones", () => {
  it("picks deleted layers whose newest write is older than the cutoff", () => {
    const doc = applyAll(emptyDoc(), [
      create("old", 1), del("old", 2),
      create("live", 1),
      create("touched", 1), del("touched", 2), set("touched", 5, 100), // edit after delete
    ]);
    expect(expiredTombstones(doc, 50)).toEqual(["old"]);
    expect(expiredTombstones(doc, 101)).toEqual(["old", "touched"]);
  });
});

/** A room on a fake clock with one connected client "a~1" (whose messages land in `inbox`). */
function setup(options: { snapshotEvery?: number; catchupWindow?: number } = {}) {
  let now = 1_000 * DAY;
  const store = new InMemoryPersister();
  const opts = { tombstoneTtlMs: TTL, now: () => now, ...options };
  let room = new Room(store.load(), opts);
  const inbox: ServerMessage[] = [];
  room.connect("a~1", (m) => inbox.push(m));
  let cseq = 0;
  const send = (...ops: Op[]) =>
    room.receive("a~1", { t: "ops", batch: ops.map((op) => ({ cseq: ++cseq, op })) });
  const flush = (compact = false) => {
    const batch = room.takeBatch({ compact });
    if (batch) {
      store.write(batch);
      room.commit(batch);
    }
    return batch;
  };
  return {
    store,
    get room() {
      return room;
    },
    inbox,
    send,
    flush,
    advance: (ms: number) => (now += ms),
    get now() {
      return now;
    },
    restart: () => {
      room = new Room(store.load(), opts);
      room.connect("a~1", (m) => inbox.push(m));
    },
  };
}

describe("Room tombstone cleanup", () => {
  it("purges expired tombstones at snapshot time and broadcasts the purge in sequence", () => {
    const t = setup({ snapshotEvery: 1_000 });
    const start = t.now;
    t.send(create("l1", start), create("l2", start), del("l1", start + 1));
    t.flush();
    expect(t.room.committedDoc.layers.has("l1")).toBe(true);

    t.advance(TTL + 10);
    t.flush(true); // idle compaction: snapshot below snapshotEvery
    expect(t.room.committedDoc.layers.has("l1")).toBe(false);
    expect(t.room.committedDoc.layers.has("l2")).toBe(true);
    const purge = t.inbox.filter((m) => m.t === "ops").at(-1) as Extract<ServerMessage, { t: "ops" }>;
    expect(purge).toMatchObject({ seq: 4, batch: [{ kind: "purge", layer: "l1", ts: { client: SERVER_CLIENT } }] });
    expect(t.store.load().snapshot!.doc.map((r) => r.id)).toEqual(["l2"]);
  });

  it("does not purge a tombstone that was written to recently", () => {
    const t = setup();
    t.send(create("l", t.now), del("l", t.now + 1));
    t.flush();
    t.advance(TTL - DAY);
    t.send(set("l", 9, t.now)); // an edit on the deleted layer refreshes it
    t.flush();
    t.advance(2 * DAY);
    t.flush(true);
    expect(t.room.committedDoc.layers.has("l")).toBe(true);
  });

  it("rejects later ops on a purged layer with LAYER_GONE, still advancing cseq", () => {
    const t = setup();
    t.send(create("l", t.now), del("l", t.now + 1));
    t.flush();
    t.advance(TTL + 10);
    t.flush(true);
    t.inbox.length = 0;

    // A client back from a long offline period: undo of the delete, then an edit.
    t.send({ kind: "restore", layer: "l", ts: ts(t.now) }, set("l", 3, t.now + 1), create("m", t.now + 2));
    t.flush();
    expect(t.inbox.filter((m) => m.t === "error")).toEqual([
      { t: "error", code: "INVALID_OP", cseq: 3, message: LAYER_GONE },
      { t: "error", code: "INVALID_OP", cseq: 4, message: LAYER_GONE },
    ]);
    expect(t.inbox).toContainEqual(expect.objectContaining({ t: "ack", upTo: 5 }));
    expect(t.room.committedDoc.layers.has("l")).toBe(false);
    expect(t.room.committedDoc.layers.has("m")).toBe(true);
  });

  it("checks layers against accepted-but-unwritten ops, not just committed state", () => {
    const t = setup({ snapshotEvery: 1 });
    t.send(create("l", t.now), del("l", t.now + 1));
    t.flush();
    t.advance(TTL + 10);
    t.send(create("n", t.now));
    const batch = t.room.takeBatch()!; // carries the purge of "l"; not durable yet
    expect(batch.entries.map((e) => e.op.kind)).toEqual(["create", "purge"]);
    t.send(set("n", 1, t.now + 1), set("l", 1, t.now + 2)); // "n" exists only in flight
    t.store.write(batch);
    t.room.commit(batch);
    t.inbox.length = 0;
    t.flush();
    expect(t.inbox.filter((m) => m.t === "error").map((m) => (m as { cseq: number }).cseq)).toEqual([5]);
  });

  it("keeps purged layers gone across a restart", () => {
    const t = setup();
    t.send(create("l", t.now), del("l", t.now + 1));
    t.flush();
    t.advance(TTL + 10);
    t.flush(true);
    t.restart();
    expect(t.room.committedDoc.layers.has("l")).toBe(false);
    t.send(set("l", 1, t.now));
    t.flush();
    expect(t.inbox.at(-2)).toMatchObject({ t: "error", message: LAYER_GONE });
  });

  it("compaction does nothing when there is nothing to compact", () => {
    const t = setup();
    expect(t.flush(true)).toBeNull();
    t.send(create("l", t.now));
    t.flush(true);
    expect(t.flush(true)).toBeNull(); // snapshot already at head, no tombstones
  });

  it("never accepts purge ops from clients", () => {
    const t = setup();
    t.send(create("l", t.now));
    t.flush();
    t.send({ kind: "purge", layer: "l", ts: ts(t.now) });
    t.flush();
    expect(t.inbox).toContainEqual(expect.objectContaining({ t: "error", cseq: 2 }));
    expect(t.room.committedDoc.layers.has("l")).toBe(true);
  });
});

describe("SyncClient after tombstone cleanup", () => {
  /** Room plus two clients wired synchronously; `b` can be taken offline. */
  function world(options: { catchupWindow?: number } = {}) {
    let now = 1_000 * DAY;
    const store = new InMemoryPersister();
    const room = new Room(store.load(), { tombstoneTtlMs: TTL, now: () => now, ...options });
    const flush = (compact = false) => {
      const batch = room.takeBatch({ compact });
      if (batch) {
        store.write(batch);
        room.commit(batch);
      }
    };
    const errors: string[] = [];
    const make = (id: string) => {
      const replica = new Replica(id, { now: () => now, maxDriftMs: Infinity });
      const client: SyncClient = new SyncClient(replica, (m: ClientMessage) => room.receive(id, m), {
        onError: (_cseq, message) => errors.push(`${id}: ${message}`),
      });
      const online = () => {
        room.connect(id, (m) => client.onMessage(m));
        client.onOpen();
      };
      const offline = () => {
        room.disconnect(id);
        client.onClose();
      };
      return { client, replica, online, offline };
    };
    return { room, flush, errors, make, advance: (ms: number) => (now += ms) };
  }

  it("a client following the log removes the layer when the purge arrives", () => {
    const w = world();
    const a = w.make("a~1");
    const b = w.make("b~1");
    a.online();
    b.online();
    a.client.mutate((tx) => tx.create("l", { x: 1 }));
    w.flush();
    b.client.mutate((tx) => tx.delete("l"));
    w.flush();
    w.advance(TTL + 10);
    w.flush(true);
    expect(a.replica.doc.layers.has("l")).toBe(false);
    expect(b.replica.doc.layers.has("l")).toBe(false);
  });

  it("a client offline past the window drops the purged layer from the snapshot, keeps its own new layers", () => {
    const w = world({ catchupWindow: 2 });
    const a = w.make("a~1");
    const b = w.make("b~1");
    a.online();
    b.online();
    a.client.mutate((tx) => tx.create("l", { x: 1 }));
    w.flush();
    b.offline(); // b still sees "l"
    a.client.mutate((tx) => tx.delete("l"));
    for (let i = 0; i < 3; i++) a.client.mutate((tx) => tx.create(`pad${i}`, { x: i })); // push b out of the window
    w.flush();
    w.advance(TTL + 10);
    w.flush(true);

    // Offline, b edits the layer it still sees and creates a new one.
    b.client.mutate((tx) => tx.set("l", "x", 42));
    b.client.mutate((tx) => tx.create("mine", { x: 7 }));
    b.online();
    w.flush();

    expect(w.errors).toEqual(["b~1: LAYER_GONE"]);
    expect(b.replica.doc.layers.has("l")).toBe(false);
    expect(isVisible(b.replica.doc.layers.get("mine"))).toBe(true);
    expect(isVisible(a.replica.doc.layers.get("mine"))).toBe(true);
    expect(b.client.pending).toEqual([]);
    expect([...b.replica.doc.layers.keys()].sort()).toEqual([...w.room.committedDoc.layers.keys()].sort());
  });

  it("drops its own create that the server wrote and purged while the ack was lost", () => {
    const w = world({ catchupWindow: 1 });
    const a = w.make("a~1");
    // Connect with a socket whose messages to the client are lost (acks included).
    w.room.connect("a~1", () => {});
    a.client.onOpen();
    a.client.mutate((tx) => tx.create("l", { x: 1 }));
    a.client.mutate((tx) => tx.delete("l"));
    w.flush();
    expect(a.client.pending).toHaveLength(2); // never saw the ack
    a.offline();
    w.advance(TTL + 10);
    w.flush(true);
    expect(w.room.committedDoc.layers.has("l")).toBe(false);

    // Reconnect. The room answers the resent queue with a re-ack and then a welcome whose
    // snapshot lacks "l"; deliver the welcome first, as a reordering network may.
    const replies: ServerMessage[] = [];
    w.room.connect("a~1", (m) => replies.push(m));
    a.client.onOpen();
    expect(replies.map((m) => m.t)).toEqual(["ack", "welcome"]);
    a.client.onMessage(replies[1]!);
    expect(a.replica.doc.layers.has("l")).toBe(false); // the create is durable, so not "ours to keep"
    a.client.onMessage(replies[0]!);
    expect(a.client.pending).toEqual([]);
  });

  it("ignores a stale welcome snapshot instead of resurrecting a purged layer", () => {
    const w = world({ catchupWindow: 1 });
    const a = w.make("a~1");
    a.online();
    a.client.mutate((tx) => tx.create("l", { x: 1 }));
    a.client.mutate((tx) => tx.delete("l"));
    w.flush();
    // A heartbeat answer built now (holding the tombstone) but delivered late.
    const late: ServerMessage[] = [];
    w.room.connect("a~1", (m) => late.push(m));
    w.room.receive("a~1", { t: "hello", lastSeq: 0, pending: [] });
    w.room.connect("a~1", (m) => a.client.onMessage(m));
    w.advance(TTL + 10);
    w.flush(true);
    expect(a.replica.doc.layers.has("l")).toBe(false);
    a.client.onMessage(late[0]!);
    expect(a.replica.doc.layers.has("l")).toBe(false);
  });
});
