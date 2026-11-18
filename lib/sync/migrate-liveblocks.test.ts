import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { docFromJSON } from "@boardbuddy/sync-core";
import { BuddySyncConnection, type AuthResult } from "@boardbuddy/sync-client";
import { MemoryPersister, startSyncServer, TOKEN_AUDIENCE, TOKEN_ISSUER } from "@boardbuddy/sync-server";

import { LayerType } from "@/types/canvas";
import { StorageViewCache } from "./layer-doc";
import { buildMigrationBatch, liveblocksToPlain, migrateBoard, parseStorage } from "./migrate-liveblocks";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});

const red = { r: 243, g: 82, b: 35 };
const plainBoard = {
  layers: {
    a: { type: LayerType.Rectangle, x: 10, y: 20, width: 100, height: 50, fill: red },
    b: { type: LayerType.Note, x: 0, y: 0, width: 80, height: 80, fill: red, value: "hello" },
    c: { type: LayerType.Path, x: 5, y: 5, width: 30, height: 30, fill: red, points: [[0, 0, 0.5], [10, 12, 0.5]] },
  },
  // Not insertion order: b was sent to the back.
  layerIds: ["b", "a", "c"],
};

/** The same board as Liveblocks' LSON format. */
const lo = (data: unknown) => ({ liveblocksType: "LiveObject", data });
const lsonBoard = lo({
  layers: {
    liveblocksType: "LiveMap",
    data: Object.fromEntries(Object.entries(plainBoard.layers).map(([id, l]) => [id, lo(l)])),
  },
  layerIds: { liveblocksType: "LiveList", data: plainBoard.layerIds },
});

describe("parsing Liveblocks storage", () => {
  it("unwraps LSON to the same thing as plain JSON", () => {
    expect(liveblocksToPlain(lsonBoard)).toEqual(plainBoard);
    expect(parseStorage(lsonBoard)).toEqual(parseStorage(plainBoard));
  });

  it("rejects shapes that aren't a board", () => {
    expect(parseStorage(null)).toBeNull();
    expect(parseStorage({ layers: [], layerIds: [] })).toBeNull();
    expect(parseStorage({ layers: {}, layerIds: [1] })).toBeNull();
    expect(parseStorage({})).toEqual({ layers: {}, layerIds: [] }); // a room nobody drew in
  });
});

describe("buildMigrationBatch", () => {
  it("keeps every layer and the stacking order", () => {
    const { batch, layers } = buildMigrationBatch(parseStorage(plainBoard)!);
    expect(layers).toBe(3);
    const view = new StorageViewCache().get(docFromJSON(batch!.snapshot!.doc));
    expect(view.layerIds).toEqual(["b", "a", "c"]);
    expect(view.layers.get("a")).toEqual(plainBoard.layers.a);
    expect(view.layers.get("b")).toEqual(plainBoard.layers.b);
    expect(view.layers.get("c")).toEqual(plainBoard.layers.c);
  });

  it("writes ops and a snapshot that agree, like a compacted log", () => {
    const { batch } = buildMigrationBatch(parseStorage(plainBoard)!);
    expect(batch!.entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(batch!.snapshot!.seq).toBe(3);
    expect(batch!.cseqs).toEqual(batch!.snapshot!.cseqs);
  });

  it("leaves out orphans and dangling ids, and coerces bad values", () => {
    const { layers, orphans, missing, batch } = buildMigrationBatch({
      layers: { a: { type: LayerType.Ellipse, x: "oops" as never, y: 1, width: 2, height: 3 }, ghost: { type: 0 } },
      layerIds: ["a", "gone", "a"],
    });
    expect(layers).toBe(1);
    expect(orphans).toEqual(["ghost"]);
    expect(missing).toEqual(["gone", "a"]);
    const record = batch!.snapshot!.doc.find((r) => r.id === "a")!;
    expect(record.fields.x!.v).toBe(0);
    expect(record.fields.fill!.v).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe("migrateBoard", () => {
  const fetchFrom = (rooms: Record<string, unknown>) => async (id: string) => rooms[id] ?? null;

  it("dry run writes nothing", async () => {
    const target = new MemoryPersister();
    const result = await migrateBoard("board_1", { fetchStorage: fetchFrom({ board_1: plainBoard }), target, dryRun: true });
    expect(result).toMatchObject({ status: "would-migrate", layers: 3 });
    expect((await target.load("board_1")).snapshot).toBeUndefined();
  });

  it("never touches a board that already has BuddySync data, so re-running is safe", async () => {
    const target = new MemoryPersister();
    const deps = { fetchStorage: fetchFrom({ board_1: plainBoard }), target, dryRun: false };
    expect(await migrateBoard("board_1", deps)).toMatchObject({ status: "migrated" });
    const before = await target.load("board_1");
    expect(await migrateBoard("board_1", deps)).toMatchObject({ status: "skipped", reason: "already has BuddySync data" });
    expect(await target.load("board_1")).toEqual(before);
  });

  it("skips missing rooms and empty boards, and reports failures without throwing", async () => {
    const target = new MemoryPersister();
    const fetchStorage = fetchFrom({ empty: { layers: {}, layerIds: [] }, weird: { layers: "x" } });
    expect(await migrateBoard("nope", { fetchStorage, target, dryRun: false })).toMatchObject({ status: "skipped", reason: "no Liveblocks room" });
    expect(await migrateBoard("empty", { fetchStorage, target, dryRun: false })).toMatchObject({ status: "skipped", reason: "empty board" });
    expect(await migrateBoard("weird", { fetchStorage, target, dryRun: false })).toMatchObject({ status: "failed" });
    const broken = { load: async () => { throw new Error("db down"); }, write: async () => {} };
    expect(await migrateBoard("x", { fetchStorage, target: broken, dryRun: false })).toEqual({ boardId: "x", status: "failed", error: "db down" });
  });

  it("a real client loads the migrated board from the sync server, and can keep editing it", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const persister = new MemoryPersister();
    await migrateBoard("board_1", { fetchStorage: fetchFrom({ board_1: lsonBoard }), target: persister, dryRun: false });

    const server = await startSyncServer({ port: 0, host: "127.0.0.1", publicKey, persister, room: { flushMs: 10 } });
    cleanup.push(() => server.close());
    const authenticate = async (boardId: string): Promise<AuthResult> => {
      const exp = Math.floor(Date.now() / 1000) + 300;
      const token = await new SignJWT({ boardId, orgId: "org_1", role: "editor", name: "A" })
        .setProtectedHeader({ alg: "EdDSA" })
        .setSubject("user_a")
        .setIssuer(TOKEN_ISSUER)
        .setAudience(TOKEN_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(exp)
        .sign(privateKey);
      return { token, userId: "user_a", expiresAt: exp * 1000, url: `ws://127.0.0.1:${server.port}` };
    };
    const client = new BuddySyncConnection({ boardId: "board_1", authenticate, store: null });
    cleanup.push(() => client.stop());
    client.start();
    await waitFor(() => client.status === "connected");

    const view = new StorageViewCache().get(client.replica!.doc);
    expect(view.layerIds).toEqual(["b", "a", "c"]);
    expect(Object.fromEntries(view.layers)).toEqual(plainBoard.layers);

    client.sync!.mutate((tx) => tx.set("a", "x", 99));
    await waitFor(() => client.sync!.pending.length === 0);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
