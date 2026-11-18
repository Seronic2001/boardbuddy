import { docToJSON, Replica, type Json, type PersistBatch } from "@boardbuddy/sync-core";

import { plainToLayer, storageForTx } from "./layer-doc";

/**
 * Liveblocks room storage → BuddySync, one board at a time.
 *
 * The board is rebuilt with the canvas's own mutation code (storageForTx), one layer at a
 * time in Liveblocks' layerIds order, so each lands on top and the stacking is kept. The
 * result is written as one batch: the create ops plus a snapshot at the last seq, which is
 * what a board looks like after normal log compaction.
 *
 * Boards that already have BuddySync data are never touched, so re-running is safe.
 * Run it before anyone opens the board on BuddySync: a sync server that already has the
 * (empty) room open keeps showing it empty until the room is idle-closed and reloaded.
 */

/** Author of the migrated ops. Real clients are `${userId}~${tabId}`, so this can't clash. */
export const MIGRATION_CLIENT = "migration~liveblocks";

/** Same as the canvas's MAX_LAYERS; bigger boards migrate but can't add layers. */
const LAYER_CAP = 100;

export type PlainStorage = {
  layers: Record<string, Record<string, Json>>;
  layerIds: string[];
};

/**
 * Liveblocks' REST API returns storage either as plain JSON or as LSON, where every live
 * structure is `{ liveblocksType, data }`. This accepts both.
 */
export function liveblocksToPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(liveblocksToPlain);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.liveblocksType === "string" && "data" in obj) return liveblocksToPlain(obj.data);
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, liveblocksToPlain(v)]));
  }
  return value;
}

/** Validates the board shape the canvas used on Liveblocks. Null if it isn't one. */
export function parseStorage(raw: unknown): PlainStorage | null {
  const plain = liveblocksToPlain(raw);
  if (!plain || typeof plain !== "object") return null;
  const { layers = {}, layerIds = [] } = plain as Record<string, unknown>;
  if (typeof layers !== "object" || layers === null || Array.isArray(layers)) return null;
  if (!Array.isArray(layerIds) || !layerIds.every((id) => typeof id === "string")) return null;
  return { layers: layers as PlainStorage["layers"], layerIds };
}

export type BuildResult = {
  batch: PersistBatch | null;
  layers: number;
  /** In `layers` but not `layerIds`: never drawn on Liveblocks, so left out. */
  orphans: string[];
  /** In `layerIds` but without data (or listed twice): skipped. */
  missing: string[];
};

export function buildMigrationBatch(storage: PlainStorage): BuildResult {
  const replica = new Replica(MIGRATION_CLIENT);
  const seen = new Set<string>();
  const missing: string[] = [];
  const ops = [];

  for (const id of storage.layerIds) {
    const raw = storage.layers[id];
    if (seen.has(id) || !raw || typeof raw !== "object") {
      missing.push(id);
      continue;
    }
    seen.add(id);
    const layer = plainToLayer((name) => raw[name]);
    ops.push(...replica.mutate((tx) => storageForTx(tx).get("layers").set(id, layer)));
  }

  const orphans = Object.keys(storage.layers).filter((id) => !seen.has(id));
  if (ops.length === 0) return { batch: null, layers: 0, orphans, missing };

  const entries = ops.map((op, i) => ({ seq: i + 1, client: MIGRATION_CLIENT, cseq: i + 1, op }));
  const cseqs = { [MIGRATION_CLIENT]: ops.length };
  return {
    batch: {
      entries,
      cseqs,
      snapshot: { seq: ops.length, doc: docToJSON(replica.doc), cseqs, headTs: ops.at(-1)!.ts },
    },
    layers: seen.size,
    orphans,
    missing,
  };
}

/** The part of the sync server's Persister this needs. */
export interface MigrationTarget {
  load(boardId: string): Promise<{ snapshot?: unknown; entries: readonly unknown[] }>;
  write(boardId: string, batch: PersistBatch): Promise<void>;
}

export type BoardResult =
  | { boardId: string; status: "migrated" | "would-migrate"; layers: number; warnings: string[] }
  | { boardId: string; status: "skipped"; reason: string }
  | { boardId: string; status: "failed"; error: string };

export async function migrateBoard(
  boardId: string,
  deps: {
    /** Raw storage from Liveblocks; null if the room doesn't exist. */
    fetchStorage(boardId: string): Promise<unknown | null>;
    target: MigrationTarget;
    dryRun: boolean;
  },
): Promise<BoardResult> {
  try {
    const existing = await deps.target.load(boardId);
    if (existing.snapshot || existing.entries.length > 0) {
      return { boardId, status: "skipped", reason: "already has BuddySync data" };
    }

    const raw = await deps.fetchStorage(boardId);
    if (raw === null) return { boardId, status: "skipped", reason: "no Liveblocks room" };
    const storage = parseStorage(raw);
    if (!storage) return { boardId, status: "failed", error: "unrecognised Liveblocks storage shape" };

    const { batch, layers, orphans, missing } = buildMigrationBatch(storage);
    if (!batch) return { boardId, status: "skipped", reason: "empty board" };

    const warnings: string[] = [];
    if (orphans.length) warnings.push(`${orphans.length} layer(s) not in layerIds were left out`);
    if (missing.length) warnings.push(`${missing.length} layerIds entr(ies) without data were skipped`);
    if (layers > LAYER_CAP) warnings.push(`${layers} layers is over the ${LAYER_CAP}-layer cap; no new layers can be added`);

    if (deps.dryRun) return { boardId, status: "would-migrate", layers, warnings };

    await deps.target.write(boardId, batch);
    return { boardId, status: "migrated", layers, warnings };
  } catch (err) {
    return { boardId, status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
