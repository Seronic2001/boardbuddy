import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Room, type LogEntry, type Op } from "@boardbuddy/sync-core";
import { GroupCommitPersister } from "../src/group-commit";
import { PostgresPersister } from "../src/postgres";

/**
 * Runs against a real Postgres. Start one with `docker compose up -d` at the repo root and
 * run with DATABASE_URL=postgres://buddysync:buddysync@localhost:5433/buddysync
 */
const url = process.env.DATABASE_URL;

const op = (n: number): Op => ({
  kind: "set",
  layer: "l",
  field: "x",
  v: n,
  ts: { wall: n, counter: 0, client: "user_a~tab00001" },
});
const entry = (seq: number, cseq = seq): LogEntry => ({ seq, client: "user_a~tab00001", cseq, op: op(seq) });

describe.skipIf(!url)("PostgresPersister", () => {
  let db: PostgresPersister;
  const board = () => `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(() => {
    execFileSync("npx", ["tsx", fileURLToPath(new URL("../scripts/migrate.ts", import.meta.url))], {
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    db = new PostgresPersister(url!);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("an empty board loads as empty", async () => {
    expect(await db.load(board())).toEqual({ entries: [], cseqs: {} });
  });

  it("round-trips entries and cseqs", async () => {
    const b = board();
    await db.write(b, { entries: [entry(1), entry(2)], cseqs: { "user_a~tab00001": 2 } });
    await db.write(b, { entries: [entry(3)], cseqs: { "user_a~tab00001": 3 } });
    const state = await db.load(b);
    expect(state.entries).toEqual([entry(1), entry(2), entry(3)]);
    expect(state.cseqs).toEqual({ "user_a~tab00001": 3 });
  });

  it("a snapshot compacts the log, and a Room restores from snapshot plus tail", async () => {
    const b = board();
    const room = new Room({ entries: [], cseqs: {} }, { snapshotEvery: 3 });
    room.connect("user_a~tab00001", () => {});
    for (let i = 1; i <= 7; i++) {
      const next: Op = i === 1 ? { kind: "create", layer: "l", fields: { x: 1 }, ts: op(1).ts } : op(i);
      room.receive("user_a~tab00001", { t: "ops", batch: [{ cseq: i, op: next }] });
      const batch = room.takeBatch()!;
      await db.write(b, batch);
      room.commit(batch);
    }
    const state = await db.load(b);
    expect(state.snapshot?.seq).toBe(6);
    expect(state.entries.map((e) => e.seq)).toEqual([7]);
    const restored = new Room(state);
    expect(restored.seq).toBe(7);
    expect(restored.committedDoc.layers.get("l")!.fields.x!.v).toBe(7);
    expect(restored.durableCseq("user_a~tab00001")).toBe(7);
  });

  it("stores purge ops and keeps purged layers gone after a reload", async () => {
    const b = board();
    const DAY = 24 * 60 * 60 * 1000;
    let now = 1_000 * DAY;
    const client = "user_a~tab00001";
    const opts = { now: () => now };
    const room = new Room({ entries: [], cseqs: {} }, opts);
    room.connect(client, () => {});
    const ts = (wall: number) => ({ wall, counter: 0, client });
    const write = async (compact = false) => {
      const batch = room.takeBatch({ compact })!;
      await db.write(b, batch);
      room.commit(batch);
    };
    room.receive(client, {
      t: "ops",
      batch: [
        { cseq: 1, op: { kind: "create", layer: "a", fields: { x: 1 }, ts: ts(now) } },
        { cseq: 2, op: { kind: "create", layer: "b", fields: { x: 2 }, ts: ts(now) } },
        { cseq: 3, op: { kind: "delete", layer: "a", ts: ts(now + 1) } },
        { cseq: 4, op: { kind: "delete", layer: "b", ts: ts(now + 2) } },
      ],
    });
    await write();
    now += 31 * DAY;
    // Idle compaction: two purge rows (authored by ~server, cseq = seq) and the snapshot
    // after them go in one transaction, which also compacts the log up to the snapshot.
    await write(true);
    const state = await db.load(b);
    expect(state.snapshot?.seq).toBe(6);
    expect(state.snapshot?.doc).toEqual([]);
    const restored = new Room(state, opts);
    expect(restored.committedDoc.layers.size).toBe(0);
    expect(restored.durableCseq(client)).toBe(4);
    expect(restored.durableCseq("~server")).toBe(0);
  });

  describe("two instances on one board (a deploy that briefly overlaps old and new)", () => {
    const A = "user_a~tab00001";
    const B = "user_b~tab00002";
    const set = (client: string, v: number): Op => ({ kind: "set", layer: "l", field: "x", v, ts: { wall: 1_000 + v, counter: 0, client } });

    async function seeded() {
      const b = board();
      const create: Op = { kind: "create", layer: "l", fields: { x: 0 }, ts: { wall: 1_000, counter: 0, client: A } };
      await db.write(b, { entries: [{ seq: 1, client: A, cseq: 1, op: create }], cseqs: { [A]: 1 } });
      return b;
    }

    it("can't fork the log: whoever writes a seq second fails, and nothing of its batch is stored", async () => {
      const b = await seeded();
      const state = await db.load(b);
      const oldRoom = new Room(state);
      const newRoom = new Room(state);
      oldRoom.connect(A, () => {});
      newRoom.connect(B, () => {});
      oldRoom.receive(A, { t: "ops", batch: [{ cseq: 2, op: set(A, 2) }] });
      newRoom.receive(B, { t: "ops", batch: [{ cseq: 1, op: set(B, 3) }] });
      const fromOld = oldRoom.takeBatch()!;
      const fromNew = newRoom.takeBatch()!;
      expect(fromOld.entries[0]!.seq).toBe(2);
      expect(fromNew.entries[0]!.seq).toBe(2); // both picked the same next seq

      await db.write(b, fromOld);
      oldRoom.commit(fromOld);
      await expect(db.write(b, fromNew)).rejects.toThrow(); // primary key (board_id, seq)

      const after = await db.load(b);
      expect(after.entries.map((e) => [e.seq, e.client])).toEqual([[1, A], [2, A]]);
      expect(after.cseqs).toEqual({ [A]: 2 }); // B was never acked, so it still holds its op

      // B reconnects to a freshly loaded room and resends: it lands after A's op.
      const reloaded = new Room(after);
      reloaded.connect(B, () => {});
      reloaded.receive(B, { t: "hello", lastSeq: 1, pending: [{ cseq: 1, op: set(B, 3) }] });
      const retry = reloaded.takeBatch()!;
      await db.write(b, retry);
      reloaded.commit(retry);
      expect(reloaded.seq).toBe(3);
      expect(reloaded.committedDoc.layers.get("l")!.fields.x!.v).toBe(3);
    });

    it("a stale instance's idle snapshot can't roll the board back", async () => {
      const b = await seeded();
      const state = await db.load(b);
      const stale = new Room(state); // loaded at seq 1, then stops seeing writes
      const live = new Room(state);
      live.connect(A, () => {});
      live.receive(A, { t: "ops", batch: [{ cseq: 2, op: set(A, 2) }, { cseq: 3, op: set(A, 3) }] });
      const batch = live.takeBatch()!;
      await db.write(b, batch);
      live.commit(batch);

      const idle = stale.takeBatch({ compact: true })!; // snapshot at its own head, seq 1
      expect(idle.entries).toEqual([]);
      await db.write(b, idle);

      const restored = new Room(await db.load(b));
      expect(restored.seq).toBe(3);
      expect(restored.committedDoc.layers.get("l")!.fields.x!.v).toBe(3);
      expect(restored.durableCseq(A)).toBe(3);
    });
  });

  it("a failed batch leaves nothing behind (atomic)", async () => {
    const b = board();
    await db.write(b, { entries: [entry(1)], cseqs: { "user_a~tab00001": 1 } });
    // seq 1 again violates the primary key, so the whole transaction must roll back.
    await expect(
      db.write(b, { entries: [entry(2), entry(1, 9)], cseqs: { "user_a~tab00001": 9 } }),
    ).rejects.toThrow();
    const state = await db.load(b);
    expect(state.entries.map((e) => e.seq)).toEqual([1]);
    expect(state.cseqs).toEqual({ "user_a~tab00001": 1 });
  });

  it("writes several boards in one transaction, all or nothing", async () => {
    const [b1, b2] = [board(), board()];
    await db.write(b1, { entries: [entry(1)], cseqs: { "user_a~tab00001": 1 } });
    // b1's seq 1 again violates the primary key, so b2's batch must not land either.
    await expect(
      db.writeMany([
        { boardId: b2, batch: { entries: [entry(1)], cseqs: { "user_a~tab00001": 1 } } },
        { boardId: b1, batch: { entries: [entry(1, 9)], cseqs: { "user_a~tab00001": 9 } } },
      ]),
    ).rejects.toThrow();
    expect(await db.load(b2)).toEqual({ entries: [], cseqs: {} });

    await db.writeMany([
      { boardId: b1, batch: { entries: [entry(2)], cseqs: { "user_a~tab00001": 2 } } },
      { boardId: b2, batch: { entries: [entry(1)], cseqs: { "user_a~tab00001": 1 } } },
    ]);
    expect((await db.load(b1)).entries.map((e) => e.seq)).toEqual([1, 2]);
    expect((await db.load(b2)).entries.map((e) => e.seq)).toEqual([1]);
  });

  it("keeps the snapshot's head timestamp, so a restarted room can check a client's lastSeq", async () => {
    const b = board();
    const headTs = op(2).ts;
    await db.write(b, {
      entries: [entry(1), entry(2)],
      cseqs: { "user_a~tab00001": 2 },
      snapshot: { seq: 2, doc: [], cseqs: { "user_a~tab00001": 2 }, headTs },
    });
    expect((await db.load(b)).snapshot).toEqual({ seq: 2, doc: [], cseqs: { "user_a~tab00001": 2 }, headTs });
  });

  it("cseq high-water marks never go backwards", async () => {
    const b = board();
    await db.write(b, { entries: [], cseqs: { c: 5 } });
    await db.write(b, { entries: [], cseqs: { c: 3 } });
    expect((await db.load(b)).cseqs).toEqual({ c: 5 });
  });
});

describe.skipIf(!url)("sync server on Postgres", () => {
  it("edits on several boards survive a server restart (through group commit)", async () => {
    const { startSyncServer } = await import("../src/server");
    const { keyPair, signToken, TestClient, waitFor } = await import("./helpers");
    const { readLayer } = await import("@boardbuddy/sync-core");
    const { privateKey, publicKey } = await keyPair();
    const boardId = `pgboard_${Date.now()}`;
    const otherBoard = `${boardId}_other`;

    const start = async () => {
      const db = new GroupCommitPersister(new PostgresPersister(url!));
      const server = await startSyncServer({ port: 0, host: "127.0.0.1", publicKey, persister: db, room: { flushMs: 10 } });
      return { db, server };
    };
    const join = async (port: number, userId: string, board = boardId) => {
      const c = new TestClient(`ws://127.0.0.1:${port}`, await signToken(privateKey, { userId, boardId: board }), userId);
      return c.connect();
    };

    let { db, server } = await start();
    const a = await join(server.port, "user_a");
    const other = await join(server.port, "user_c", otherBoard);
    for (let i = 0; i < 30; i++) {
      a.sync.mutate((tx) => tx.create(`l${i}`, { x: i }));
      other.sync.mutate((tx) => tx.create(`o${i}`, { x: i }));
    }
    a.sync.mutate((tx) => tx.delete("l3"));
    await waitFor(() => a.sync.pending.length === 0 && other.sync.pending.length === 0, 5_000, "all acked");
    await a.close();
    await other.close();
    await server.close();
    await db.close();

    ({ db, server } = await start());
    const b = await join(server.port, "user_b");
    await waitFor(() => readLayer(b.sync.replica.doc, "l29") !== undefined, 5_000, "state after restart");
    expect(readLayer(b.sync.replica.doc, "l3")).toBeUndefined();
    expect(readLayer(b.sync.replica.doc, "l7")).toEqual({ x: 7 });
    const c = await join(server.port, "user_d", otherBoard);
    await waitFor(() => readLayer(c.sync.replica.doc, "o29") !== undefined, 5_000, "other board after restart");
    await b.close();
    await c.close();
    await server.close();
    await db.close();
  });
});

describe.skipIf(!url)("sync server on a Postgres restored from an older backup", () => {
  it("clients that are ahead keep syncing, and the edits the restore lost come back", async () => {
    const pg = (await import("pg")).default;
    const { startSyncServer } = await import("../src/server");
    const { keyPair, signToken, TestClient, waitFor } = await import("./helpers");
    const { readLayer } = await import("@boardbuddy/sync-core");
    const { privateKey, publicKey } = await keyPair();
    const boardId = `pgrestore_${Date.now()}`;
    const sql = new pg.Client({ connectionString: url });
    await sql.connect();
    const tables = ["board_ops", "board_snapshots", "board_client_cseqs"];

    let port = 0;
    const start = async () => {
      const db = new PostgresPersister(url!);
      const server = await startSyncServer({ port, host: "127.0.0.1", publicKey, persister: db, room: { flushMs: 10 } });
      port = server.port;
      return { db, server };
    };
    const client = async (userId: string) =>
      new TestClient(`ws://127.0.0.1:${port}`, await signToken(privateKey, { userId, boardId }), userId);

    try {
      let { db, server } = await start();
      const writer = await (await client("user_w")).connect();
      const reader = await (await client("user_r")).connect();
      writer.sync.mutate((tx) => tx.create("kept", { x: 1 }));
      await waitFor(() => writer.sync.pending.length === 0, 5_000, "first edit acked");

      // "Backup": copy this board's rows aside.
      for (const t of tables) {
        await sql.query(`create table ${t}_bak_${boardId} as select * from ${t} where board_id = $1`, [boardId]);
      }
      writer.sync.mutate((tx) => tx.create("lost", { x: 2 }));
      writer.sync.mutate((tx) => tx.set("kept", "x", 5));
      await waitFor(() => writer.sync.pending.length === 0, 5_000, "later edits acked");
      await waitFor(() => readLayer(reader.sync.replica.doc, "lost") !== undefined, 5_000, "reader saw them");

      // Restore the backup while the server is down; the clients stay as they were.
      await server.close();
      await db.close();
      for (const t of tables) {
        await sql.query(`delete from ${t} where board_id = $1`, [boardId]);
        await sql.query(`insert into ${t} select * from ${t}_bak_${boardId}`);
      }
      ({ db, server } = await start());
      await writer.connect();
      await reader.connect();

      writer.sync.mutate((tx) => tx.set("kept", "y", 1));
      await waitFor(() => writer.sync.pending.length === 0, 5_000, "a new edit from the writer gets through");

      const newcomer = await (await client("user_n")).connect();
      newcomer.sync.mutate((tx) => tx.create("after", { x: 3 }));
      const expected = { kept: { x: 5, y: 1 }, lost: { x: 2 }, after: { x: 3 } };
      const visible = (c: InstanceType<typeof TestClient>) =>
        Object.fromEntries(["kept", "lost", "after"].map((id) => [id, readLayer(c.sync.replica.doc, id)]));
      for (const c of [writer, reader, newcomer]) {
        await waitFor(() => JSON.stringify(visible(c)) === JSON.stringify(expected), 5_000, `${c.userId} converged`);
      }
      await Promise.all([writer.close(), reader.close(), newcomer.close()]);
      await server.close();
      await db.close();
    } finally {
      for (const t of tables) await sql.query(`drop table if exists ${t}_bak_${boardId}`);
      await sql.end();
    }
  }, 30_000);
});
