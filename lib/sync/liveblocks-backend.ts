import { LiveObject, type LiveList, type LiveMap, type Room } from "@liveblocks/client";
import type { Layer } from "@/types/canvas";
import {
  type LayerHandle,
  type LayerIdList,
  type LayersMap,
  type MutableStorage,
  type Presence,
  type StorageView,
  type SyncBackend,
  type SyncStatus,
  type User,
} from "./types";

type Storage = {
  layers: LiveMap<string, LiveObject<Layer>>;
  layerIds: LiveList<string>;
};
type UserMeta = { id?: string; info?: { name?: string; picture?: string } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LbRoom = Room<Presence, Storage, UserMeta, any>;

/**
 * SyncBackend on the old Liveblocks room: the rollback path while boards move to
 * BuddySync. Stateless: Liveblocks already caches immutable snapshots, `self` and
 * `others`, so every getter returns a stable object until something changes.
 * The Room component makes sure storage and self are loaded before this is used.
 */
export class LiveblocksBackend implements SyncBackend {
  readonly kind = "liveblocks" as const;

  constructor(private readonly room: LbRoom) {}

  private get root() {
    const root = this.room.getStorageSnapshot();
    if (!root) throw new Error("Liveblocks storage is not loaded");
    return root;
  }

  getStorage(): StorageView {
    return this.root.toImmutable() as unknown as StorageView;
  }

  subscribeStorage(listener: () => void): () => void {
    return this.room.events.storage.subscribe(() => listener());
  }

  mutate<T>(fn: (storage: MutableStorage) => T): T {
    const root = this.root;
    const liveLayers = root.get("layers");
    const liveIds = root.get("layerIds");

    const layers: LayersMap = {
      get size() {
        return liveLayers.size;
      },
      get: (id) => liveLayers.get(id) as unknown as LayerHandle | undefined,
      set: (id, layer) => liveLayers.set(id, new LiveObject(layer)),
      delete: (id) => liveLayers.delete(id),
      toImmutable: () => liveLayers.toImmutable() as ReadonlyMap<string, Layer>,
    };
    const layerIds: LayerIdList = {
      get length() {
        return liveIds.length;
      },
      push: (id) => liveIds.push(id),
      move: (from, to) => liveIds.move(from, to),
      indexOf: (id) => liveIds.indexOf(id),
      delete: (index) => liveIds.delete(index),
      toImmutable: () => liveIds.toImmutable(),
    };
    function get(key: "layers"): LayersMap;
    function get(key: "layerIds"): LayerIdList;
    function get(key: "layers" | "layerIds"): LayersMap | LayerIdList {
      return key === "layers" ? layers : layerIds;
    }
    return this.room.batch(() => fn({ get }));
  }

  getSelf(): User {
    const self = this.room.getSelf();
    if (!self) throw new Error("Liveblocks self is not available yet");
    return self as unknown as User;
  }

  getOthers(): readonly User[] {
    return this.room.getOthers() as unknown as readonly User[];
  }

  subscribePresence(listener: () => void): () => void {
    const a = this.room.events.others.subscribe(() => listener());
    const b = this.room.events.self.subscribe(() => listener());
    return () => {
      a();
      b();
    };
  }

  updatePresence(patch: Partial<Presence>, options?: { addToHistory?: boolean }): void {
    this.room.updatePresence(
      patch,
      options?.addToHistory !== undefined ? { addToHistory: options.addToHistory } : undefined,
    );
  }

  get history() {
    return this.room.history;
  }

  canUndo(): boolean {
    return this.room.history.canUndo();
  }

  canRedo(): boolean {
    return this.room.history.canRedo();
  }

  subscribeHistory(listener: () => void): () => void {
    return this.room.events.history.subscribe(() => listener());
  }

  getStatus(): SyncStatus {
    switch (this.room.getStatus()) {
      case "connected":
        return "connected";
      case "reconnecting":
        return "reconnecting";
      case "disconnected":
        return "disconnected";
      default:
        return "connecting";
    }
  }

  subscribeStatus(listener: () => void): () => void {
    return this.room.events.status.subscribe(() => listener());
  }
}
