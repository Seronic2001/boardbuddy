import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CryptoKey } from "jose";
import { canonical, CloseCode, readLayer } from "@boardbuddy/sync-core";
import { MemoryPersister } from "../src/persister";
import { startSyncServer, type SyncServer } from "../src/server";
import { keyPair, signAdminToken, signToken, TestClient, waitFor, type TokenClaims } from "./helpers";

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let otherPrivateKey: CryptoKey;
const open: (SyncServer | TestClient)[] = [];

beforeAll(async () => {
  ({ privateKey, publicKey } = await keyPair());
  ({ privateKey: otherPrivateKey } = await keyPair());
});

afterEach(async () => {
  for (const x of open.reverse()) await x.close();
  open.length = 0;
});

async function server(persister = new MemoryPersister(), room = {}) {
  const s = await startSyncServer({
    port: 0,
    host: "127.0.0.1",
    publicKey,
    persister,
    room: { flushMs: 10, presenceGraceMs: 100, ...room },
  });
  open.push(s);
  return s;
}

async function client(s: SyncServer, claims: TokenClaims, tab?: string, opts: { batchPresence?: boolean } = {}) {
  const c = new TestClient(`ws://127.0.0.1:${s.port}`, await signToken(privateKey, claims), claims.userId, tab);
  c.batchPresence = opts.batchPresence ?? false;
  open.push(c);
  return c.connect();
}

const BOARD = "board_1";

describe("sync server", () => {
  it("two clients edit the same board and converge; the board survives a server restart", async () => {
    const persister = new MemoryPersister();
    const s = await server(persister);
    const a = await client(s, { userId: "user_a", boardId: BOARD });
    const b = await client(s, { userId: "user_b", boardId: BOARD });

    a.sync.mutate((tx) => tx.create("l1", { x: 0, fill: "red", z: "V" }));
    await waitFor(() => readLayer(b.sync.replica.doc, "l1") !== undefined, 3_000, "create to reach b");
    a.sync.mutate((tx) => tx.set("l1", "x", 50));
    b.sync.mutate((tx) => tx.set("l1", "fill", "blue"));
    await waitFor(() => a.sync.pending.length === 0 && b.sync.pending.length === 0, 3_000, "acks");
    await waitFor(() => canonical(a.sync.replica.doc) === canonical(b.sync.replica.doc), 3_000, "convergence");
    expect(readLayer(a.sync.replica.doc, "l1")).toEqual({ x: 50, fill: "blue", z: "V" });

    // Restart with the same storage: a fresh client gets the board from storage.
    await s.close();
    const s2 = await server(persister);
    const c = await client(s2, { userId: "user_c", boardId: BOARD });
    await waitFor(() => readLayer(c.sync.replica.doc, "l1") !== undefined, 3_000, "state after restart");
    expect(readLayer(c.sync.replica.doc, "l1")).toEqual({ x: 50, fill: "blue", z: "V" });
  });

  it("rooms are isolated by board", async () => {
    const s = await server();
    const a = await client(s, { userId: "user_a", boardId: "board_x" });
    const b = await client(s, { userId: "user_b", boardId: "board_y" });
    a.sync.mutate((tx) => tx.create("l1", { x: 1 }));
    await waitFor(() => a.sync.pending.length === 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(b.sync.replica.doc.layers.size).toBe(0);
  });

  it("an offline client's edits merge when it reconnects", async () => {
    const s = await server();
    const a = await client(s, { userId: "user_a", boardId: BOARD });
    const b = await client(s, { userId: "user_b", boardId: BOARD });
    a.sync.mutate((tx) => tx.create("l1", { x: 0, fill: "red" }));
    await waitFor(() => readLayer(b.sync.replica.doc, "l1") !== undefined);

    await a.close(); // goes offline and keeps editing
    a.sync.mutate((tx) => tx.set("l1", "x", 99));
    a.sync.mutate((tx) => tx.create("l2", { x: 5 }));
    b.sync.mutate((tx) => tx.set("l1", "fill", "green"));
    await waitFor(() => b.sync.pending.length === 0);

    await a.connect();
    await waitFor(() => a.sync.pending.length === 0, 3_000, "offline ops acked");
    await waitFor(() => canonical(a.sync.replica.doc) === canonical(b.sync.replica.doc), 3_000, "convergence");
    expect(readLayer(b.sync.replica.doc, "l1")).toEqual({ x: 99, fill: "green" });
    expect(readLayer(b.sync.replica.doc, "l2")).toEqual({ x: 5 });
  });

  it("rejects bad, foreign-key and expired tokens", async () => {
    const s = await server();
    const url = `ws://127.0.0.1:${s.port}`;

    const bad = new TestClient(url, "not-a-jwt", "user_a");
    open.push(bad);
    await bad.connect();
    expect(await bad.waitForClose()).toBe(CloseCode.Unauthorized);

    const forged = new TestClient(url, await signToken(otherPrivateKey, { userId: "user_a", boardId: BOARD }), "user_a");
    open.push(forged);
    await forged.connect();
    expect(await forged.waitForClose()).toBe(CloseCode.Unauthorized);

    const expired = new TestClient(url, await signToken(privateKey, { userId: "user_a", boardId: BOARD, expiresInSec: -10 }), "user_a");
    open.push(expired);
    await expired.connect();
    expect(await expired.waitForClose()).toBe(CloseCode.TokenExpired);
  });

  it("closes the session when the token expires, unless the client reauths", async () => {
    const s = await server();
    const a = await client(s, { userId: "user_a", boardId: BOARD, expiresInSec: 1 });
    const b = await client(s, { userId: "user_b", boardId: BOARD, expiresInSec: 1 });
    b.sendRaw({ t: "reauth", token: await signToken(privateKey, { userId: "user_b", boardId: BOARD }) });
    expect(await a.waitForClose()).toBe(CloseCode.TokenExpired);
    await new Promise((r) => setTimeout(r, 300));
    expect(b.closeCode).toBeNull();
  }, 5_000);

  it("rejects a reauth token for another board", async () => {
    const s = await server();
    const a = await client(s, { userId: "user_a", boardId: BOARD });
    a.sendRaw({ t: "reauth", token: await signToken(privateKey, { userId: "user_a", boardId: "board_other" }) });
    expect(await a.waitForClose()).toBe(CloseCode.Unauthorized);
  });

  it("rejects ops authored as someone else, without blocking later ops", async () => {
    const s = await server();
    const a = await client(s, { userId: "user_a", boardId: BOARD });
    const ts = { wall: Date.now(), counter: 0, client: "user_b~tab999999" };
    a.sendRaw({ t: "ops", batch: [{ cseq: 1, op: { kind: "create", layer: "evil", fields: {}, ts } }] });
    await waitFor(() => a.received.some((m) => m.t === "error" && m.cseq === 1), 3_000, "error");
    // The real client's queue starts at cseq 1 too; that slot is used, so bump past it.
    a.sendRaw({
      t: "ops",
      batch: [{ cseq: 2, op: { kind: "create", layer: "ok", fields: {}, ts: { ...ts, client: a.key } } }],
    });
    await waitFor(() => a.received.some((m) => m.t === "ack" && m.upTo === 2), 3_000, "ack");
    expect(s.rooms.size).toBe(1);
  });

  it("rejects timestamps far in the future and enforces the layer cap", async () => {
    const s = await server(undefined, { maxLayers: 2 });
    const a = await client(s, { userId: "user_a", boardId: BOARD });
    const ts = (wall: number) => ({ wall, counter: 0, client: a.key });
    a.sendRaw({ t: "ops", batch: [{ cseq: 1, op: { kind: "create", layer: "l0", fields: {}, ts: ts(Date.now() + 3_600_000) } }] });
    await waitFor(() => a.received.some((m) => m.t === "error" && m.cseq === 1 && m.message.includes("skew")));
    for (let i = 2; i <= 4; i++) {
      a.sendRaw({ t: "ops", batch: [{ cseq: i, op: { kind: "create", layer: `l${i}`, fields: {}, ts: ts(Date.now()) } }] });
      await waitFor(() => a.received.some((m) => m.t === "ack" && m.upTo === i), 3_000, `ack ${i}`);
    }
    expect(a.received.some((m) => m.t === "error" && m.cseq === 4 && m.message === "LAYER_CAP")).toBe(true);
  });

  it("viewers receive updates but cannot write", async () => {
    const s = await server();
    const viewer = await client(s, { userId: "user_v", boardId: BOARD, role: "viewer" });
    const editor = await client(s, { userId: "user_e", boardId: BOARD });
    viewer.sync.mutate((tx) => tx.create("nope", { x: 1 }));
    await waitFor(() => viewer.received.some((m) => m.t === "read-only"), 3_000, "read-only");
    editor.sync.mutate((tx) => tx.create("yes", { x: 1 }));
    await waitFor(() => readLayer(viewer.sync.replica.doc, "yes") !== undefined);
    expect(readLayer(editor.sync.replica.doc, "nope")).toBeUndefined();
  });

  it("relays presence with join and leave", async () => {
    const s = await server();
    const a = await client(s, { userId: "user_a", boardId: BOARD, name: "Ada" });
    const b = await client(s, { userId: "user_b", boardId: BOARD });
    await waitFor(() => a.others.has(b.key) && b.others.has(a.key), 3_000, "presence join");
    expect(b.others.get(a.key)!.user.name).toBe("Ada");

    a.presence({ cursor: { x: 10, y: 20 } });
    a.presence({ selection: ["l1"] });
    await waitFor(() => (b.others.get(a.key)?.data.selection as string[] | undefined)?.[0] === "l1");
    expect(b.others.get(a.key)!.data).toEqual({ cursor: { x: 10, y: 20 }, selection: ["l1"] });

    await a.close();
    await waitFor(() => !b.others.has(a.key), 3_000, "presence leave after grace");
  });

  it("drops presence at once on a deliberate close, after the grace period otherwise", async () => {
    const s = await server(undefined, { presenceGraceMs: 600 });
    const watcher = await client(s, { userId: "user_w", boardId: BOARD });
    const left = await client(s, { userId: "user_a", boardId: BOARD });
    const closedTab = await client(s, { userId: "user_b", boardId: BOARD });
    const dropped = await client(s, { userId: "user_c", boardId: BOARD });
    await waitFor(() => watcher.others.size === 3, 3_000, "presence join");

    await left.close(1000); // left the board
    await closedTab.close(1001); // closed the tab
    await waitFor(() => !watcher.others.has(left.key) && !watcher.others.has(closedTab.key), 200, "immediate leave");

    const droppedAt = Date.now();
    await dropped.terminate(); // network gone: might come straight back
    await new Promise((r) => setTimeout(r, 300));
    expect(watcher.others.has(dropped.key)).toBe(true);
    await waitFor(() => !watcher.others.has(dropped.key), 3_000, "leave after grace");
    expect(Date.now() - droppedAt).toBeGreaterThanOrEqual(550);
  });

  it("throttles presence to one message per interval per user, keeping the latest value", async () => {
    const s = await server(undefined, { presenceIntervalMs: 100 });
    const a = await client(s, { userId: "user_a", boardId: BOARD });
    const b = await client(s, { userId: "user_b", boardId: BOARD });
    await waitFor(() => b.others.has(a.key));
    for (let i = 0; i < 50; i++) a.presence({ cursor: { x: i, y: i } });
    await waitFor(() => (b.others.get(a.key)?.data.cursor as { x: number } | undefined)?.x === 49);
    const count = b.received.filter((m) => m.t === "presence").length;
    expect(count).toBeLessThanOrEqual(3);
  });

  it("batches presence for clients that ask, and keeps per-update messages for older clients", async () => {
    const s = await server(undefined, { presenceIntervalMs: 100 });
    const batched = { batchPresence: true };
    const a = await client(s, { userId: "user_a", boardId: BOARD }, undefined, batched);
    const b = await client(s, { userId: "user_b", boardId: BOARD }, undefined, batched);
    const old = await client(s, { userId: "user_old", boardId: BOARD });
    await waitFor(() => a.others.size === 2 && b.others.size === 2 && old.others.size === 2, 3_000, "presence join");
    // Let the throttle window from any earlier presence pass, so both updates share a batch.
    await new Promise((r) => setTimeout(r, 150));
    for (const c of [a, b, old]) c.received.length = 0;

    a.presence({ cursor: { x: 1, y: 1 } });
    b.presence({ cursor: { x: 2, y: 2 } });
    old.presence({ cursor: { x: 3, y: 3 } });
    await waitFor(() => (a.others.get(old.key)?.data.cursor as { x: number } | undefined)?.x === 3, 3_000, "a sees old");
    await waitFor(() => (old.others.get(b.key)?.data.cursor as { x: number } | undefined)?.x === 2, 3_000, "old sees b");
    await waitFor(() => (b.others.get(a.key)?.data.cursor as { x: number } | undefined)?.x === 1, 3_000, "b sees a");

    // The first update goes out at once (a alone); b's and old's share the next batch.
    const batches = a.received.filter((m) => m.t === "presence-batch");
    expect(batches.map((m) => m.updates.map((u) => u.id))).toEqual([[a.key], [b.key, old.key]]);
    expect(a.received.some((m) => m.t === "presence")).toBe(false);
    // The older client gets one message per other user, and never its own.
    const singles = old.received.filter((m) => m.t === "presence");
    expect(singles.map((m) => m.id).sort()).toEqual([a.key, b.key].sort());
    expect(old.received.some((m) => m.t === "presence-batch")).toBe(false);
    // A client ignores its own entry in a batch.
    expect(a.others.has(a.key)).toBe(false);
  });

  it("a second connection from the same tab replaces the first", async () => {
    const s = await server();
    const first = await client(s, { userId: "user_a", boardId: BOARD }, "sametab01");
    await waitFor(() => first.received.some((m) => m.t === "presence-state"));
    await client(s, { userId: "user_a", boardId: BOARD }, "sametab01");
    expect(await first.waitForClose()).toBe(CloseCode.Replaced);
  });

  describe("revoking access", () => {
    const revoke = (s: SyncServer, token: string) =>
      fetch(`http://127.0.0.1:${s.port}/admin/revoke`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

    it("disconnects a removed member at once and refuses their tokens", async () => {
      const s = await server();
      const a = await client(s, { userId: "user_a", boardId: BOARD });
      const b = await client(s, { userId: "user_b", boardId: BOARD });
      const elsewhere = await client(s, { userId: "user_b", boardId: "board_2", orgId: "org_2" });
      await waitFor(() => s.rooms.size === 2);
      await waitFor(() => a.others.size === 1, 3_000, "presence");

      const res = await revoke(s, await signAdminToken(privateKey, { action: "revoke", orgId: "org_1", userId: "user_b" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, disconnected: 1 });
      expect(await b.waitForClose()).toBe(CloseCode.Unauthorized);
      expect(b.received).toContainEqual({ t: "fatal", code: "UNAUTHORIZED", message: "Access revoked" });
      await new Promise((r) => setTimeout(r, 100));
      expect(a.closeCode).toBeNull();
      expect(elsewhere.closeCode).toBeNull(); // other org untouched

      // The old token, and a fresh one issued while Clerk may still be stale, are refused.
      await b.connect();
      expect(await b.waitForClose()).toBe(CloseCode.Unauthorized);
      const fresh = await client(s, { userId: "user_b", boardId: BOARD });
      expect(await fresh.waitForClose()).toBe(CloseCode.Unauthorized);
    });

    it("an org-wide revocation disconnects everyone in that org", async () => {
      const s = await server();
      const a = await client(s, { userId: "user_a", boardId: BOARD });
      const b = await client(s, { userId: "user_b", boardId: "board_x" });
      await waitFor(() => s.rooms.size === 2);
      const res = await revoke(s, await signAdminToken(privateKey, { action: "revoke", orgId: "org_1" }));
      expect(await res.json()).toEqual({ ok: true, disconnected: 2 });
      expect(await a.waitForClose()).toBe(CloseCode.Unauthorized);
      expect(await b.waitForClose()).toBe(CloseCode.Unauthorized);
    });

    it("refuses a reauth with a token issued before the revocation took effect", async () => {
      const s = await server();
      const a = await client(s, { userId: "user_a", boardId: BOARD });
      await waitFor(() => s.rooms.size === 1);
      // Recorded without closing sessions, to isolate the reauth check.
      s.revocations.revoke({ orgId: "org_1", userId: "user_a" });
      a.sendRaw({ t: "reauth", token: await signToken(privateKey, { userId: "user_a", boardId: BOARD }) });
      expect(await a.waitForClose()).toBe(CloseCode.Unauthorized);
    });

    it("rejects missing, forged, wrong-audience and empty admin requests", async () => {
      const s = await server();
      const a = await client(s, { userId: "user_a", boardId: BOARD });
      await waitFor(() => s.rooms.size === 1);
      const attempts = [
        await fetch(`http://127.0.0.1:${s.port}/admin/revoke`, { method: "POST" }),
        await revoke(s, await signAdminToken(otherPrivateKey, { action: "revoke", orgId: "org_1" })),
        await revoke(s, await signToken(privateKey, { userId: "user_a", boardId: BOARD })), // a room token
        await revoke(s, await signAdminToken(privateKey, { action: "revoke" })),
        await revoke(s, await signAdminToken(privateKey, { action: "delete", orgId: "org_1" })),
      ];
      expect(attempts.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
      await new Promise((r) => setTimeout(r, 100));
      expect(a.closeCode).toBeNull();
    });
  });

  it("closes the socket on malformed messages", async () => {
    const s = await server();
    const a = await client(s, { userId: "user_a", boardId: BOARD });
    a.socket.send("{not json");
    expect(await a.waitForClose()).toBe(CloseCode.BadMessage);
  });

  it("shutdown writes every accepted op before closing", async () => {
    const persister = new MemoryPersister();
    const s = await server(persister, { flushMs: 60_000 }); // no periodic flush
    const a = await client(s, { userId: "user_a", boardId: BOARD });
    a.sync.mutate((tx) => tx.create("l1", { x: 1 }));
    await waitFor(() => s.rooms.size === 1);
    await new Promise((r) => setTimeout(r, 50)); // let the op reach the room
    await s.close();
    const state = await persister.load(BOARD);
    // Shutdown also compacts: the op is in the snapshot, and the log before it is gone.
    expect(state.snapshot?.doc.map((r) => r.id)).toEqual(["l1"]);
    expect(state.entries).toEqual([]);
  });

  it("an idle room purges tombstones older than the offline window", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let now = Date.now();
    const persister = new MemoryPersister();
    const s = await server(persister, { idleMs: 50, now: () => now, maxSkewMs: 60 * DAY });
    const a = await client(s, { userId: "user_a", boardId: BOARD });
    a.sync.mutate((tx) => tx.create("gone", { x: 1 }));
    a.sync.mutate((tx) => tx.create("kept", { x: 2 }));
    a.sync.mutate((tx) => tx.delete("gone"));
    await waitFor(() => a.sync.pending.length === 0, 3_000, "acks");
    await a.close();

    now += 31 * DAY;
    await waitFor(() => s.rooms.size === 0, 3_000, "idle room to unload");
    const state = await persister.load(BOARD);
    expect(state.snapshot?.doc.map((r) => r.id)).toEqual(["kept"]);

    // A client joining later never sees the purged layer.
    const b = await client(s, { userId: "user_b", boardId: BOARD });
    await waitFor(() => readLayer(b.sync.replica.doc, "kept") !== undefined, 3_000, "snapshot");
    expect(b.sync.replica.doc.layers.has("gone")).toBe(false);
  });
});
