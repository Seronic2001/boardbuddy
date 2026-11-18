import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { BuddySyncConnection, type AuthResult } from "@boardbuddy/sync-client";
import { MemoryPersister, startSyncServer, TOKEN_AUDIENCE, TOKEN_ISSUER } from "@boardbuddy/sync-server";
import { LayerType, type Layer } from "@/types/canvas";
import { BuddySyncBackend } from "./buddysync-backend";

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

async function waitFor(check: () => boolean, what = "condition") {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 4_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function backendFor(port: number, userId: string): Promise<BuddySyncBackend> {
  const authenticate = async (boardId: string): Promise<AuthResult> => {
    const exp = Math.floor(Date.now() / 1000) + 300;
    const token = await new SignJWT({ boardId, orgId: "org_1", role: "editor", name: userId })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject(userId)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(privateKey);
    return { token, userId, expiresAt: exp * 1000, url: `ws://127.0.0.1:${port}`, name: userId };
  };
  const connection = new BuddySyncConnection({ boardId: "board_1", authenticate });
  cleanup.push(() => connection.stop());
  connection.start();
  await waitFor(() => connection.isLoaded, `${userId} loaded`);
  return new BuddySyncBackend(connection);
}

const note = (x: number): Layer => ({
  type: LayerType.Note,
  x,
  y: 10,
  width: 100,
  height: 100,
  fill: { r: 255, g: 200, b: 0 },
  value: "hello",
});

describe("BuddySyncBackend against a real sync server", () => {
  it("canvas-style mutations, presence and undo work across two tabs", async () => {
    const server = await startSyncServer({
      port: 0,
      host: "127.0.0.1",
      publicKey,
      persister: new MemoryPersister(),
      room: { flushMs: 10, presenceIntervalMs: 5 },
    });
    cleanup.push(() => server.close());
    const a = await backendFor(server.port, "user_a");
    const b = await backendFor(server.port, "user_b");

    // insertLayer + setMyPresence, as one mutation (canvas.tsx)
    a.mutate((storage) => {
      storage.get("layerIds").push("n1");
      storage.get("layers").set("n1", note(5));
      a.updatePresence({ selection: ["n1"] }, { addToHistory: true });
    });
    await waitFor(() => b.getStorage().layers.has("n1"), "layer reaches b");
    expect(b.getStorage().layers.get("n1")).toEqual(note(5));
    expect(b.getStorage().layerIds).toEqual(["n1"]);

    // b sees a's selection with a's name, coerced to the Presence shape
    await waitFor(() => b.getOthers()[0]?.presence.selection[0] === "n1", "selection presence");
    const other = b.getOthers()[0]!;
    expect(other.info?.name).toBe("user_a");
    expect(other.presence).toEqual({ cursor: null, selection: ["n1"], pencilDraft: null, penColor: null });
    expect(a.getSelf().presence.selection).toEqual(["n1"]);

    // translate (a drag is paused into one undo step) then undo
    a.history.pause();
    for (let i = 1; i <= 5; i++) {
      a.mutate((storage) => {
        const layer = storage.get("layers").get("n1")!;
        layer.update({ x: layer.get("x") + 10 });
      });
    }
    a.history.resume();
    await waitFor(() => b.getStorage().layers.get("n1")?.x === 55, "drag reaches b");
    expect(a.canUndo()).toBe(true);
    a.history.undo();
    await waitFor(() => b.getStorage().layers.get("n1")?.x === 5, "undo reaches b");

    // nested mutation joins the outer batch (onPointerUp calls insertPath etc.)
    a.mutate((outer) => {
      a.mutate((inner) => inner.get("layers").set("n2", note(0)));
      outer.get("layerIds").push("n2");
    });
    await waitFor(() => b.getStorage().layerIds.length === 2, "nested insert");
    a.history.undo();
    await waitFor(() => !b.getStorage().layers.has("n2"), "nested insert undone in one step");
    expect(b.getStorage().layers.has("n1")).toBe(true);
  });

  it("presence from a misbehaving client cannot crash the canvas", async () => {
    const server = await startSyncServer({
      port: 0,
      host: "127.0.0.1",
      publicKey,
      persister: new MemoryPersister(),
      room: { flushMs: 10, presenceIntervalMs: 5 },
    });
    cleanup.push(() => server.close());
    const a = await backendFor(server.port, "user_a");
    const b = await backendFor(server.port, "user_b");
    // Bypass the typed API, like a hand-crafted socket message would.
    (a as unknown as { connection: BuddySyncConnection }).connection.updatePresence({
      cursor: "x",
      selection: [1, "ok", null],
      pencilDraft: [[1, 2], "bad", [3, 4, 0.9]],
      penColor: { r: "red" },
    });
    await waitFor(() => b.getOthers()[0]?.presence.selection.length === 1, "junk presence");
    expect(b.getOthers()[0]!.presence).toEqual({
      cursor: null,
      selection: ["ok"],
      pencilDraft: [
        [1, 2, 0.5],
        [3, 4, 0.9],
      ],
      penColor: null,
    });
  });
});
