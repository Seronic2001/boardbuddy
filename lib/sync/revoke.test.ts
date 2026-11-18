import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import type { WebhookEvent } from "@clerk/nextjs/webhooks";
import { MemoryPersister, startSyncServer, type SyncServer } from "@boardbuddy/sync-server";
import { revocationFor, revokeSyncAccess, syncAdminUrl } from "./revoke";

describe("revocationFor", () => {
  const evt = (type: string, data: unknown) => ({ type, data, object: "event" }) as unknown as WebhookEvent;

  it("maps Clerk events that take access away", () => {
    expect(
      revocationFor(evt("organizationMembership.deleted", { organization: { id: "org_1" }, public_user_data: { user_id: "user_b" } })),
    ).toEqual({ orgId: "org_1", userId: "user_b" });
    expect(revocationFor(evt("organization.deleted", { id: "org_1", deleted: true }))).toEqual({ orgId: "org_1" });
    expect(revocationFor(evt("user.deleted", { id: "user_b", deleted: true }))).toEqual({ userId: "user_b" });
  });

  it("ignores events that don't", () => {
    expect(revocationFor(evt("organizationMembership.created", {}))).toBeNull();
    expect(revocationFor(evt("user.deleted", { deleted: true }))).toBeNull();
  });
});

describe("syncAdminUrl", () => {
  it("derives the HTTP URL from the WebSocket URL unless SYNC_ADMIN_URL is set", () => {
    expect(syncAdminUrl({ NEXT_PUBLIC_SYNC_URL: "wss://sync.example.com/" })).toBe("https://sync.example.com");
    expect(syncAdminUrl({ NEXT_PUBLIC_SYNC_URL: "ws://localhost:8787" })).toBe("http://localhost:8787");
    expect(syncAdminUrl({ SYNC_ADMIN_URL: "http://internal:8787", NEXT_PUBLIC_SYNC_URL: "wss://x" })).toBe("http://internal:8787");
    expect(syncAdminUrl({})).toBeNull();
  });
});

describe("revokeSyncAccess against a real sync server", () => {
  let server: SyncServer;
  let privateKey: string;

  beforeAll(async () => {
    const keys = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    privateKey = await exportPKCS8(keys.privateKey);
    server = await startSyncServer({ port: 0, host: "127.0.0.1", publicKey: keys.publicKey, persister: new MemoryPersister() });
  });
  afterAll(() => server.close());

  it("signs an admin token the server accepts", async () => {
    const adminUrl = `http://127.0.0.1:${server.port}`;
    await expect(revokeSyncAccess({ orgId: "org_1", userId: "user_b" }, { privateKey, adminUrl })).resolves.toEqual({
      disconnected: 0,
    });
    expect(server.revocations.isRevoked({ orgId: "org_1", userId: "user_b", issuedAt: Date.now() })).toBe(true);
  });

  it("throws when the server refuses, so the webhook replies non-2xx and Clerk retries", async () => {
    const other = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const adminUrl = `http://127.0.0.1:${server.port}`;
    await expect(
      revokeSyncAccess({ orgId: "org_1" }, { privateKey: await exportPKCS8(other.privateKey), adminUrl }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
