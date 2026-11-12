import { describe, expect, it } from "vitest";

import { SyncClient } from "../src/client";
import { readLayer, type Doc, type Json } from "../src/doc";
import { Replica } from "../src/replica";
import { InMemoryPersister, Room, type DurableState } from "../src/room";

/**
 * The server restored from an older backup: it lost ops it had acknowledged, and clients
 * that saw them are now ahead of it. Every client must keep syncing, and everyone must end
 * up with the same board, including the lost edits that some client still has.
 */

class Server {
  store = new InMemoryPersister();
  room: Room;

  constructor(state?: DurableState) {
    if (state) this.store.write(state.snapshot ? { ...state, snapshot: state.snapshot } : { entries: state.entries, cseqs: state.cseqs });
    this.room = new Room(this.store.load(), { snapshotEvery: 4, catchupWindow: 100 });
  }

  /** A deep copy of what's on disk now. */
  backup(): DurableState {
    return structuredClone(this.store.load());
  }

  flush() {
    for (let batch = this.room.takeBatch(); batch; batch = this.room.takeBatch()) {
      this.store.write(batch);
      this.room.commit(batch);
    }
  }
}

/** Shared fake time: every reading is 1 ms later, so later edits really are later. */
let time = 1_000_000;
const now = () => ++time;

class Tab {
  readonly replica: Replica;
  readonly sync: SyncClient;
  private server: Server | null = null;

  constructor(readonly id: string) {
    this.replica = new Replica(id, { now });
    this.sync = new SyncClient(this.replica, (m) => this.server?.room.receive(this.id, m));
  }

  connect(server: Server) {
    this.disconnect();
    this.server = server;
    server.room.connect(this.id, (m) => this.sync.onMessage(m));
    this.sync.onOpen();
    server.flush();
  }

  disconnect() {
    if (!this.server) return;
    this.server.room.disconnect(this.id);
    this.sync.onClose();
    this.server = null;
  }

  edit(fn: Parameters<SyncClient["mutate"]>[0]) {
    this.sync.mutate(fn);
    this.server?.flush();
  }
}

/** Visible layers, ordered by id: what a user sees. */
function view(doc: Doc): Record<string, Record<string, Json>> {
  const out: Record<string, Record<string, Json>> = {};
  for (const id of [...doc.layers.keys()].sort()) {
    const layer = readLayer(doc, id);
    if (layer) out[id] = layer;
  }
  return out;
}

function settle(server: Server, tabs: Tab[]) {
  // A few heartbeat rounds: each hello resends the queue and fills any catch-up gap.
  for (let i = 0; i < 3; i++) {
    for (const t of tabs) t.sync.hello();
    server.flush();
  }
}

describe("server restored from an older backup", () => {
  it("a client ahead of it keeps syncing, and the edits it lost come back for everyone", () => {
    const old = new Server();
    const writer = new Tab("w~1");
    const reader = new Tab("r~1");
    writer.connect(old);
    reader.connect(old);

    writer.edit((tx) => tx.create("kept", { x: 1 }));
    const backup = old.backup();
    writer.edit((tx) => tx.create("lost", { x: 2 }));
    writer.edit((tx) => tx.set("kept", "x", 5));
    expect(writer.sync.pending).toEqual([]); // all acked by the old server
    expect(view(reader.replica.doc)).toEqual({ kept: { x: 5 }, lost: { x: 2 } });

    // Restore. Both tabs reconnect to a server that never saw seq 2+ or cseq 2+.
    const restored = new Server(backup);
    writer.connect(restored);
    reader.connect(restored);

    // The writer's new edits get through (its cseqs continue past what the server knows).
    writer.edit((tx) => tx.set("kept", "y", 1));

    // A newcomer sees the restored board, including the edits the server had lost.
    const newcomer = new Tab("n~1");
    newcomer.connect(restored);
    settle(restored, [writer, reader, newcomer]);
    expect(view(newcomer.replica.doc)).toEqual({ kept: { x: 5, y: 1 }, lost: { x: 2 } });

    // And the old clients receive new edits (they don't skip seqs they think they've seen).
    newcomer.edit((tx) => tx.create("after", { x: 3 }));
    settle(restored, [writer, reader, newcomer]);
    for (const t of [writer, reader, newcomer]) {
      expect(view(t.replica.doc)).toEqual(view(restored.room.committedDoc));
    }
    expect(view(restored.room.committedDoc)).toEqual({ kept: { x: 5, y: 1 }, lost: { x: 2 }, after: { x: 3 } });
  });

  it("detects the restore even after the server has passed the client's lastSeq with other ops", () => {
    const old = new Server();
    const writer = new Tab("w~1");
    const reader = new Tab("r~1");
    writer.connect(old);
    reader.connect(old);
    writer.edit((tx) => tx.create("a", { x: 1 }));
    const backup = old.backup(); // seq 1
    writer.edit((tx) => tx.set("a", "x", 2));
    writer.edit((tx) => tx.set("a", "x", 3)); // reader's lastSeq is 3
    writer.disconnect();
    reader.disconnect();

    // While the reader is away, someone else writes seqs 2..6 on the restored server.
    const restored = new Server(backup);
    const other = new Tab("o~1");
    other.connect(restored);
    for (let i = 0; i < 5; i++) other.edit((tx) => tx.create(`o${i}`, { i }));
    expect(restored.room.seq).toBeGreaterThan(reader.sync.lastSeq);

    reader.connect(restored);
    writer.connect(restored);
    settle(restored, [reader, writer, other]);
    const expected = view(restored.room.committedDoc);
    expect(Object.keys(expected)).toEqual(["a", "o0", "o1", "o2", "o3", "o4"]);
    expect(expected.a).toEqual({ x: 3 }); // the lost edit came back
    for (const t of [reader, writer, other]) expect(view(t.replica.doc)).toEqual(expected);
  });

  it("never overrides a newer edit made on the restored server", () => {
    const old = new Server();
    const writer = new Tab("w~1");
    writer.connect(old);
    writer.edit((tx) => tx.create("a", { x: 1, y: 1 }));
    const backup = old.backup();
    writer.edit((tx) => tx.set("a", "x", 2)); // lost
    writer.disconnect();

    const restored = new Server(backup);
    const other = new Tab("o~1");
    other.connect(restored);
    other.edit((tx) => tx.set("a", "x", 7));
    other.edit((tx) => tx.set("a", "y", 8));

    writer.connect(restored);
    settle(restored, [writer, other]);
    expect(view(restored.room.committedDoc).a).toEqual({ x: 7, y: 8 });
    expect(view(writer.replica.doc)).toEqual(view(other.replica.doc));
  });

  it("an ordinary reconnect still gets an ops catch-up, also after a restart from a snapshot", () => {
    const server = new Server();
    const writer = new Tab("w~1");
    const reader = new Tab("r~1");
    writer.connect(server);
    reader.connect(server);
    for (let i = 0; i < 6; i++) writer.edit((tx) => tx.create(`l${i}`, { i })); // snapshot at 4
    reader.disconnect();

    const restarted = new Server(server.backup()); // same data: a restart, not a restore
    const welcomes: unknown[] = [];
    restarted.room.connect("spy", (m) => welcomes.push(m));
    reader.connect(restarted);
    const lastTs = reader.sync.lastTs!;
    expect(lastTs).toBeDefined();
    restarted.room.receive("spy", { t: "hello", lastSeq: reader.sync.lastSeq, pending: [], lastTs });
    expect(welcomes[0]).toMatchObject({ t: "welcome", catchup: { kind: "ops", ops: [] } });
    expect(view(reader.replica.doc)).toEqual(view(server.room.committedDoc));
  });
});
