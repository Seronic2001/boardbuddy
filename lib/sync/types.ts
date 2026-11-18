import type { Color, Layer, Point } from "@/types/canvas";

/**
 * The seam between the UI and the real-time backend (Adapter pattern). Components only use
 * the hooks in ./hooks, which run on top of a SyncBackend. LiveblocksBackend wraps the old
 * service and BuddySyncBackend runs on our own sync engine. A per-board flag picks one.
 *
 * The mutation surface (MutableStorage) copies the subset of Liveblocks' LiveMap /
 * LiveObject / LiveList API that the canvas already uses, so components barely change.
 */

export type Presence = {
  cursor: Point | null;
  selection: string[];
  pencilDraft: [x: number, y: number, pressure: number][] | null;
  penColor: Color | null;
};

export const INITIAL_PRESENCE: Presence = {
  cursor: null,
  selection: [],
  pencilDraft: null,
  penColor: null,
};

export type UserInfo = { name?: string; picture?: string };

export type User = {
  /** Small number for colours and React keys. */
  readonly connectionId: number;
  readonly id?: string;
  readonly info?: UserInfo;
  readonly presence: Presence;
};

export type StorageView = {
  readonly layers: ReadonlyMap<string, Layer>;
  /** Bottom to top. */
  readonly layerIds: readonly string[];
};

type CommonLayerKey = keyof Layer;

export interface LayerHandle {
  get<K extends CommonLayerKey>(key: K): Layer[K];
  set<K extends CommonLayerKey>(key: K, value: Layer[K]): void;
  update(patch: Partial<Pick<Layer, CommonLayerKey>>): void;
}

export interface LayersMap {
  readonly size: number;
  get(id: string): LayerHandle | undefined;
  set(id: string, layer: Layer): void;
  delete(id: string): void;
  toImmutable(): ReadonlyMap<string, Layer>;
}

export interface LayerIdList {
  readonly length: number;
  push(id: string): void;
  move(from: number, to: number): void;
  indexOf(id: string): number;
  delete(index: number): void;
  toImmutable(): readonly string[];
}

export interface MutableStorage {
  get(key: "layers"): LayersMap;
  get(key: "layerIds"): LayerIdList;
}

export type HistoryApi = {
  undo(): void;
  redo(): void;
  pause(): void;
  resume(): void;
};

export type SyncStatus = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface SyncBackend {
  readonly kind: "liveblocks" | "buddysync";

  /** Must return the same object until something changes (useSyncExternalStore). */
  getStorage(): StorageView;
  subscribeStorage(listener: () => void): () => void;
  /** Runs fn as one batch: one network message, one undo step. Nested calls join the outer batch. */
  mutate<T>(fn: (storage: MutableStorage) => T): T;

  getSelf(): User;
  getOthers(): readonly User[];
  subscribePresence(listener: () => void): () => void;
  updatePresence(patch: Partial<Presence>, options?: { addToHistory?: boolean }): void;

  readonly history: HistoryApi;
  canUndo(): boolean;
  canRedo(): boolean;
  subscribeHistory(listener: () => void): () => void;

  getStatus(): SyncStatus;
  subscribeStatus(listener: () => void): () => void;
}
