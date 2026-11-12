import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { readLayer } from "@boardbuddy/sync-core";
import { MemoryPersister, startSyncServer, TOKEN_AUDIENCE, TOKEN_ISSUER } from "@boardbuddy/sync-server";
import { BuddySyncConnection, IndexedDbStore, type AuthResult, type LockManagerLike } from "../src";

let privateKey: CryptoKey;
let publicKey: CryptoKey;
const cleanup: (() => unknown)[] = [];

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" }));
});
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});

async function waitFor(check: () => boolean, what = "condition", timeoutMs = 5_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** navigator.locks semantics for `ifAvailable` requests, shared by "tabs" of one browser. */
class FakeLocks implements LockManagerLike {
  readonly held = new Set<string>();
  async request(name: string, _opts: { ifAvailable: true }, cb: (lock: unknown) => Promise<void> | void) {
    if (this.held.has(name)) return cb(null);
    this.held.add(name);
    try {
      return await cb({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

function auth(port: () => number, userId: string) {
  return async (boardId: string): Promise<AuthResult> => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = await new SignJWT({ boardId, orgId: "org_1", role: "editor", name: userId })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject(userId)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime(exp)
      .sign(privateKey);
    return { token, userId, expiresAt: exp * 1000, url: `ws://127.0.0.1:${port()}` };
  };
}

/** One browser profile: shared IndexedDB and lock manager across its tabs. */
function browser() {
  return { store: new IndexedDbStore(new IDBFactory()), locks: new FakeLocks() };
}

function tab(b: ReturnType<typeof browser>, port: () => number, userId = "user_a") {
  const c = new BuddySyncConnection({
    boardId: "board_1",
    authenticate: auth(port, userId),
    store: b.store,
    locks: b.locks,
    saveDebounceMs: 10,
    maxBackoffMs: 100,
  });
  cleanup.push(() => c.stop());
  c.start();
  return c;
}

async function server(port = 0, persister = new MemoryPersister()) {
  const s = await startSyncServer({ port, host: "127.0.0.1", publicKey, persister, room: { flushMs: 10 } });
  cleanup.push(() => s.close());
  return s;
}

describe("offline persistence", () => {
  it("unsent edits survive a reload made while offline, and sync once the server is back", async () => {
    const b = browser();
    const storage = new MemoryPersister(); // survives the server restart, like Postgres
    const s = await server(0, storage);
    const port = s.port;
    const first = tab(b, () => port);
    await waitFor(() => first.isLoaded);
    first.sync!.mutate((tx) => tx.create("before", { x: 1 }));
    await waitFor(() => first.sync!.pending.length === 0, "first edit acked");

    await s.close(); // offline from here
    await waitFor(() => first.status === "reconnecting");
    first.sync!.mutate((tx) => tx.create("offline", { x: 2 }));
    first.sync!.mutate((tx) => tx.set("before", "x", 10));
    const tabId = first.tabId;
    first.stop(); // the page is closed or reloaded
    await waitFor(() => !b.locks.held.has(`buddysync:board_1:${tabId}`), "identity released after save");

    // The reloaded page shows the board from local state before the server is reachable.
    const second = tab(b, () => port);
    await waitFor(() => second.isLoaded, "loaded from IndexedDB");
    expect(second.status).not.toBe("connected");
    expect(second.tabId).toBe(tabId);
    expect(readLayer(second.replica!.doc, "offline")).toEqual({ x: 2 });
    expect(second.sync!.pending.length).toBe(2);

    // Server comes back on the same port: the queue goes out and another user sees it.
    await server(port, storage);
    await waitFor(() => second.status === "connected" && second.sync!.pending.length === 0, "queue delivered", 8_000);
    const other = tab(browser(), () => port, "user_b");
    await waitFor(() => other.replica !== null && readLayer(other.replica.doc, "offline") !== undefined, "other user sees it");
    expect(readLayer(other.replica!.doc, "before")).toEqual({ x: 10 });
  }, 15_000);

  it("two open tabs never share an identity; a closed tab's identity is adopted", async () => {
    const b = browser();
    const s = await server();
    const t1 = tab(b, () => s.port);
    await waitFor(() => t1.isLoaded);
    const t2 = tab(b, () => s.port);
    await waitFor(() => t2.isLoaded);
    expect(t2.tabId).not.toBe(t1.tabId);

    const closedId = t1.tabId;
    t1.stop();
    await waitFor(() => !b.locks.held.has(`buddysync:board_1:${closedId}`));
    const t3 = tab(b, () => s.port);
    await waitFor(() => t3.isLoaded);
    expect(t3.tabId).toBe(closedId);
  });

  it("does not adopt another user's saved session", async () => {
    const b = browser();
    const s = await server();
    const a = tab(b, () => s.port, "user_a");
    await waitFor(() => a.isLoaded);
    const aId = a.tabId;
    a.stop();
    await waitFor(() => !b.locks.held.has(`buddysync:board_1:${aId}`));
    const other = tab(b, () => s.port, "user_b");
    await waitFor(() => other.isLoaded);
    expect(other.tabId).not.toBe(aId);
  });

  it("works without persistence when locks are unavailable", async () => {
    const s = await server();
    const c = new BuddySyncConnection({
      boardId: "board_1",
      authenticate: auth(() => s.port, "user_a"),
      store: new IndexedDbStore(new IDBFactory()),
      locks: null,
    });
    cleanup.push(() => c.stop());
    c.start();
    await waitFor(() => c.isLoaded);
    c.sync!.mutate((tx) => tx.create("x", { x: 1 }));
    await waitFor(() => c.sync!.pending.length === 0);
  });
});
