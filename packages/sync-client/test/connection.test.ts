import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { canonical, readLayer } from "@boardbuddy/sync-core";
import {
  MemoryPersister,
  startSyncServer,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  type SyncServer,
} from "@boardbuddy/sync-server";
import { AuthRejectedError, BuddySyncConnection, type AuthResult } from "../src";

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

async function waitFor(check: () => boolean, what = "condition", timeoutMs = 4_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function server(persister = new MemoryPersister()): Promise<SyncServer> {
  const s = await startSyncServer({ port: 0, host: "127.0.0.1", publicKey, persister, room: { flushMs: 10 } });
  cleanup.push(() => s.close());
  return s;
}

/** Stands in for fetch("/api/sync-auth"). */
function authenticator(urlOf: () => string, userId: string, opts: { ttlSec?: number; deny?: () => boolean } = {}) {
  let calls = 0;
  const fn = async (boardId: string): Promise<AuthResult> => {
    calls++;
    if (opts.deny?.()) throw new AuthRejectedError();
    const exp = Math.floor(Date.now() / 1000) + (opts.ttlSec ?? 300);
    const token = await new SignJWT({ boardId, orgId: "org_1", role: "editor", name: userId })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject(userId)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime(exp)
      .sign(privateKey);
    return { token, userId, expiresAt: exp * 1000, url: urlOf(), name: userId };
  };
  return Object.assign(fn, { calls: () => calls });
}

function connection(s: { port: number } | (() => string), userId: string, extra: Partial<ConstructorParameters<typeof BuddySyncConnection>[0]> = {}) {
  const url = typeof s === "function" ? s : () => `ws://127.0.0.1:${s.port}`;
  const c = new BuddySyncConnection({ boardId: "board_1", authenticate: authenticator(url, userId), ...extra });
  cleanup.push(() => c.stop());
  c.start();
  return c;
}

describe("BuddySyncConnection", () => {
  it("connects, loads, and syncs edits and presence between two tabs", async () => {
    const s = await server();
    const a = connection(s, "user_a");
    const b = connection(s, "user_b");
    await waitFor(() => a.isLoaded && b.isLoaded, "both loaded");
    expect(a.status).toBe("connected");

    a.sync!.mutate((tx) => tx.create("l1", { x: 1 }));
    await waitFor(() => readLayer(b.replica!.doc, "l1") !== undefined, "edit reaches b");

    a.updatePresence({ cursor: { x: 5, y: 6 } });
    await waitFor(() => [...b.others.values()].some((e) => (e.data.cursor as { x: number } | undefined)?.x === 5), "presence");
    expect([...b.others.values()][0]!.user.name).toBe("user_a");
  });

  it("reconnects after the server restarts, resends offline edits, and restores presence", async () => {
    const persister = new MemoryPersister();
    let s = await server(persister);
    const port = s.port;
    const url = () => `ws://127.0.0.1:${port}`;
    const a = connection(url, "user_a", { maxBackoffMs: 200 });
    const b = connection(url, "user_b", { maxBackoffMs: 200 });
    await waitFor(() => a.isLoaded && b.isLoaded);
    a.updatePresence({ selection: ["l1"] });

    await s.close();
    await waitFor(() => a.status === "reconnecting", "reconnecting");
    a.sync!.mutate((tx) => tx.create("offline", { x: 9 })); // edited while the server is down

    s = await startSyncServer({ port, host: "127.0.0.1", publicKey, persister, room: { flushMs: 10 } });
    cleanup.push(() => s.close());
    await waitFor(() => a.status === "connected" && b.status === "connected", "reconnected", 6_000);
    await waitFor(() => readLayer(b.replica!.doc, "offline") !== undefined, "offline edit delivered");
    await waitFor(() => a.sync!.pending.length === 0, "acked");
    await waitFor(
      () => [...b.others.values()].some((e) => (e.data.selection as string[] | undefined)?.[0] === "l1"),
      "presence restored after reconnect",
    );
    expect(canonical(a.replica!.doc)).toBe(canonical(b.replica!.doc));
  }, 15_000);

  it("renews its token before expiry instead of being disconnected", async () => {
    const s = await server();
    const auth = authenticator(() => `ws://127.0.0.1:${s.port}`, "user_a", { ttlSec: 2 });
    const c = new BuddySyncConnection({ boardId: "board_1", authenticate: auth, renewBeforeMs: 1_500 });
    cleanup.push(() => c.stop());
    const statuses: string[] = [];
    c.on("status", () => statuses.push(c.status));
    c.start();
    await waitFor(() => c.isLoaded);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(auth.calls()).toBeGreaterThanOrEqual(2);
    expect(statuses).not.toContain("reconnecting");
    expect(c.status).toBe("connected");
  }, 8_000);

  it("stops for good when access is denied", async () => {
    const s = await server();
    const c = new BuddySyncConnection({
      boardId: "board_1",
      authenticate: authenticator(() => `ws://127.0.0.1:${s.port}`, "user_a", { deny: () => true }),
    });
    cleanup.push(() => c.stop());
    c.start();
    await waitFor(() => c.status === "disconnected", "disconnected");
    expect(c.replica).toBeNull();
  });

  it("keeps retrying with backoff while auth is temporarily failing", async () => {
    const s = await server();
    let fail = true;
    const inner = authenticator(() => `ws://127.0.0.1:${s.port}`, "user_a");
    const c = new BuddySyncConnection({
      boardId: "board_1",
      maxBackoffMs: 100,
      authenticate: async (b) => {
        if (fail) throw new Error("network down");
        return inner(b);
      },
    });
    cleanup.push(() => c.stop());
    c.start();
    await waitFor(() => c.status === "reconnecting");
    fail = false;
    await waitFor(() => c.isLoaded, "loaded after auth recovers");
  });

  it("the same tab connecting twice stops the older connection", async () => {
    const s = await server();
    const first = connection(s, "user_a", { tabId: "sharedtab01" });
    await waitFor(() => first.isLoaded);
    const second = connection(s, "user_a", { tabId: "sharedtab01" });
    await waitFor(() => second.isLoaded);
    await waitFor(() => first.status === "disconnected", "first stopped");
  });
});
