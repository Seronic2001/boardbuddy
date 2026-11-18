import { describe, expect, it } from "vitest";
import type { Op } from "../src/doc";
import type { ServerMessage } from "../src/protocol";
import { InMemoryPersister, Room } from "../src/room";

const op = (n: number, client = "a"): Op => ({
  kind: "set",
  layer: "l",
  field: "x",
  v: n,
  ts: { wall: n, counter: 0, client },
});

/** A store holding layer "l", so the room accepts sets on it. */
function seededStore(): InMemoryPersister {
  const store = new InMemoryPersister();
  const ts = { wall: 0, counter: 0, client: "seed" };
  store.write({ entries: [], cseqs: {}, snapshot: { seq: 0, doc: [{ id: "l", fields: { deleted: { v: false, ts } } }], cseqs: {} } });
  return store;
}

function setup(options = {}) {
  const store = seededStore();
  const room = new Room(store.load(), options);
  const inbox: Record<string, ServerMessage[]> = { a: [], b: [] };
  room.connect("a", (m) => inbox.a!.push(m));
  room.connect("b", (m) => inbox.b!.push(m));
  const flush = () => {
    const batch = room.takeBatch();
    if (batch) {
      store.write(batch);
      room.commit(batch);
    }
  };
  return { store, room, inbox, flush };
}

describe("Room", () => {
  it("acks and broadcasts only after the write is committed", () => {
    const { room, inbox, flush } = setup();
    room.receive("a", { t: "ops", batch: [{ cseq: 1, op: op(1) }] });
    expect(inbox.a!.filter((m) => m.t === "ack")).toEqual([]);
    expect(inbox.b).toEqual([]);
    flush();
    expect(inbox.a).toContainEqual({ t: "ack", upTo: 1, seq: 1 });
    expect(inbox.b).toContainEqual({ t: "ops", seq: 1, batch: [op(1)] });
  });

  it("dedups resent ops and re-acks ones that are already durable", () => {
    const { room, inbox, flush } = setup();
    const batch = [
      { cseq: 1, op: op(1) },
      { cseq: 2, op: op(2) },
    ];
    room.receive("a", { t: "ops", batch });
    room.receive("a", { t: "ops", batch }); // duplicate before commit
    flush();
    expect(room.seq).toBe(2);
    inbox.a!.length = 0;
    room.receive("a", { t: "hello", lastSeq: 2, pending: batch }); // resend after reconnect
    flush();
    expect(room.seq).toBe(2);
    expect(inbox.a).toContainEqual({ t: "ack", upTo: 2, seq: 2 });
  });

  it("stops at a cseq gap; the client's resend fills it", () => {
    const { room, flush } = setup();
    room.receive("a", { t: "ops", batch: [{ cseq: 2, op: op(2) }] });
    flush();
    expect(room.seq).toBe(0);
    room.receive("a", { t: "ops", batch: [{ cseq: 1, op: op(1) }, { cseq: 2, op: op(2) }] });
    flush();
    expect(room.seq).toBe(2);
  });

  it("a crash before commit loses only unacked ops, and dedup state survives restart", () => {
    const { store, room, flush } = setup();
    room.receive("a", { t: "ops", batch: [{ cseq: 1, op: op(1) }] });
    flush();
    room.receive("a", { t: "ops", batch: [{ cseq: 2, op: op(2) }] });
    room.takeBatch(); // in flight when the server dies
    const restarted = new Room(store.load());
    expect(restarted.seq).toBe(1);
    expect(restarted.durableCseq("a")).toBe(1);
  });

  it("sends ops for a recent lastSeq and a snapshot for an old one", () => {
    const { room, inbox, flush } = setup({ catchupWindow: 3, snapshotEvery: 2 });
    for (let i = 1; i <= 6; i++) {
      room.receive("a", { t: "ops", batch: [{ cseq: i, op: op(i) }] });
      flush();
    }
    inbox.b!.length = 0;
    room.receive("b", { t: "hello", lastSeq: 4, pending: [] });
    room.receive("b", { t: "hello", lastSeq: 1, pending: [] });
    const [recent, old] = inbox.b as Extract<ServerMessage, { t: "welcome" }>[];
    expect(recent!.catchup).toEqual({ kind: "ops", from: 5, ops: [op(5), op(6)] });
    expect(old!.catchup.kind).toBe("snapshot");
  });

  it("restarts from snapshot plus the log tail", () => {
    const { store, room, flush } = setup({ snapshotEvery: 3 });
    for (let i = 1; i <= 7; i++) {
      room.receive("a", { t: "ops", batch: [{ cseq: i, op: op(i) }] });
      flush();
    }
    expect(store.logLength).toBeLessThan(7); // compacted
    const restarted = new Room(store.load());
    expect(restarted.seq).toBe(7);
    expect(restarted.committedDoc.layers.get("l")!.fields.x!.v).toBe(7);
  });

  it("rejects invalid ops with an error but still advances cseq", () => {
    const { room, inbox, flush } = setup();
    const bad: Op = { kind: "set", layer: "l", field: "deleted", v: false, ts: op(1).ts };
    room.receive("a", { t: "ops", batch: [{ cseq: 1, op: bad }, { cseq: 2, op: op(2) }] });
    flush();
    expect(inbox.a).toContainEqual(expect.objectContaining({ t: "error", cseq: 1 }));
    expect(inbox.a).toContainEqual({ t: "ack", upTo: 2, seq: 1 });
  });
});

describe("SyncClient persistence", () => {
  it("a restored client resends its queue under the same identity and the server dedups", async () => {
    const { Replica } = await import("../src/replica");
    const { SyncClient } = await import("../src/client");
    const { docFromJSON, docToJSON, readLayer } = await import("../src/doc");
    const store = new InMemoryPersister();
    const room = new Room(store.load());
    const flush = () => {
      const batch = room.takeBatch();
      if (batch) {
        store.write(batch);
        room.commit(batch);
      }
    };
    const connect = (client: InstanceType<typeof SyncClient>) => {
      room.connect("u~tab", (m) => client.onMessage(m));
      client.onOpen();
    };

    // Session 1: one op is acked, two are still pending when the tab closes.
    const r1 = new Replica("u~tab");
    const c1 = new SyncClient(r1, (m) => room.receive("u~tab", m));
    connect(c1);
    c1.mutate((tx) => tx.create("a", { x: 1 }));
    flush();
    c1.mutate((tx) => tx.create("b", { x: 2 }));
    room.disconnect("u~tab"); // the "b" op may or may not have reached the server
    c1.onClose();
    c1.mutate((tx) => tx.create("c", { x: 3 })); // offline
    const saved = { doc: docToJSON(r1.doc), ...c1.exportState() };
    expect(saved.pending.map((p) => p.cseq)).toEqual([2, 3]);

    // Session 2: a new page load adopts the saved identity.
    const r2 = new Replica("u~tab");
    r2.merge(docFromJSON(JSON.parse(JSON.stringify(saved.doc))));
    const c2 = new SyncClient(r2, (m) => room.receive("u~tab", m));
    c2.restore(JSON.parse(JSON.stringify(saved)));
    connect(c2);
    flush();
    expect(c2.pending).toEqual([]);
    expect(room.seq).toBe(3); // "b" was sequenced once even though it was sent twice
    expect(readLayer(room.committedDoc, "c")).toEqual({ x: 3 });
    // New edits continue the cseq sequence.
    c2.mutate((tx) => tx.set("a", "x", 9));
    flush();
    expect(room.durableCseq("u~tab")).toBe(4);
    expect(() => c2.restore(saved)).toThrow();
  });
});
