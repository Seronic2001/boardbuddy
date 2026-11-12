import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Room, type LogEntry, type Op } from "@boardbuddy/sync-core";
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
      room.receive("user_a~tab00001", { t: "ops", batch: [{ cseq: i, op: op(i) }] });
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
  it("edits survive a server restart and a fresh client loads them", async () => {
    const { startSyncServer } = await import("../src/server");
    const { keyPair, signToken, TestClient, waitFor } = await import("./helpers");
    const { readLayer } = await import("@boardbuddy/sync-core");
    const { privateKey, publicKey } = await keyPair();
    const boardId = `pgboard_${Date.now()}`;

    const start = async () => {
      const db = new PostgresPersister(url!);
      const server = await startSyncServer({ port: 0, host: "127.0.0.1", publicKey, persister: db, room: { flushMs: 10 } });
      return { db, server };
    };
    const join = async (port: number, userId: string) => {
      const c = new TestClient(`ws://127.0.0.1:${port}`, await signToken(privateKey, { userId, boardId }), userId);
      return c.connect();
    };

    let { db, server } = await start();
    const a = await join(server.port, "user_a");
    for (let i = 0; i < 30; i++) a.sync.mutate((tx) => tx.create(`l${i}`, { x: i }));
    a.sync.mutate((tx) => tx.delete("l3"));
    await waitFor(() => a.sync.pending.length === 0, 5_000, "all acked");
    await a.close();
    await server.close();
    await db.close();

    ({ db, server } = await start());
    const b = await join(server.port, "user_b");
    await waitFor(() => readLayer(b.sync.replica.doc, "l29") !== undefined, 5_000, "state after restart");
    expect(readLayer(b.sync.replica.doc, "l3")).toBeUndefined();
    expect(readLayer(b.sync.replica.doc, "l7")).toEqual({ x: 7 });
    await b.close();
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
