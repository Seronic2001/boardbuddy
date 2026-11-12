import type { BuddySyncConnection, ConnectionStatus } from "@boardbuddy/sync-client";
import type { PresenceData, PresenceEntry } from "@boardbuddy/sync-core";
import type { Color, Point } from "@/types/canvas";
import { storageForTx, StorageViewCache } from "./layer-doc";
import {
  INITIAL_PRESENCE,
  type HistoryApi,
  type MutableStorage,
  type Presence,
  type StorageView,
  type SyncBackend,
  type SyncStatus,
  type User,
} from "./types";

/**
 * SyncBackend on BuddySync. Expects a connection that has loaded (replica present). The
 * Room component waits for that before rendering the canvas.
 */
export class BuddySyncBackend implements SyncBackend {
  readonly kind = "buddysync" as const;
  private readonly views = new StorageViewCache();
  private readonly ids = new ConnectionIds();
  private activeStorage: MutableStorage | null = null;
  private selfCache: { presence: PresenceData; user: User } | null = null;
  private othersCache: { source: ReadonlyMap<string, PresenceEntry>; users: readonly User[] } | null = null;
  private readonly userCache = new WeakMap<PresenceEntry, User>();

  readonly history: HistoryApi;

  constructor(private readonly connection: BuddySyncConnection) {
    if (!connection.replica || !connection.sync) {
      throw new Error("BuddySyncBackend needs an authenticated connection");
    }
    const replica = connection.replica;
    const sync = connection.sync;
    this.history = {
      undo: () => void sync.undo(),
      redo: () => void sync.redo(),
      pause: () => replica.history.pause(),
      resume: () => replica.history.resume(),
    };
  }

  private get replica() {
    return this.connection.replica!;
  }

  getStorage(): StorageView {
    return this.views.get(this.replica.doc);
  }

  subscribeStorage(listener: () => void): () => void {
    return this.replica.subscribe(listener);
  }

  mutate<T>(fn: (storage: MutableStorage) => T): T {
    if (this.activeStorage) return fn(this.activeStorage); // nested: join the outer batch
    let result!: T;
    this.connection.sync!.mutate((tx) => {
      this.activeStorage = storageForTx(tx);
      try {
        result = fn(this.activeStorage);
      } finally {
        this.activeStorage = null;
      }
    });
    return result;
  }

  getSelf(): User {
    const presence = this.connection.myPresence;
    if (this.selfCache?.presence === presence) return this.selfCache.user;
    const auth = this.connection.user;
    const key = this.connection.key ?? `${auth?.userId}~${this.connection.tabId}`;
    const user: User = {
      connectionId: this.ids.get(key),
      ...(auth ? { id: auth.userId, info: { name: auth.name, picture: auth.picture } } : {}),
      presence: toPresence(presence),
    };
    this.selfCache = { presence, user };
    return user;
  }

  getOthers(): readonly User[] {
    const source = this.connection.others;
    if (this.othersCache?.source === source) return this.othersCache.users;
    const users = [...source.values()].map((entry) => {
      let user = this.userCache.get(entry);
      if (!user) {
        user = {
          connectionId: this.ids.get(entry.id),
          id: entry.user.userId,
          info: { name: entry.user.name, picture: entry.user.picture },
          presence: toPresence(entry.data),
        };
        this.userCache.set(entry, user);
      }
      return user;
    });
    this.othersCache = { source, users };
    return users;
  }

  subscribePresence(listener: () => void): () => void {
    return this.connection.on("presence", listener);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  updatePresence(patch: Partial<Presence>, _options?: { addToHistory?: boolean }): void {
    // addToHistory is ignored: BuddySync undo covers document edits only.
    this.connection.updatePresence(patch);
  }

  canUndo(): boolean {
    return this.replica.history.canUndo;
  }

  canRedo(): boolean {
    return this.replica.history.canRedo;
  }

  subscribeHistory(listener: () => void): () => void {
    return this.replica.subscribe(listener);
  }

  getStatus(): SyncStatus {
    return mapStatus(this.connection.status);
  }

  subscribeStatus(listener: () => void): () => void {
    return this.connection.on("status", listener);
  }
}

function mapStatus(status: ConnectionStatus): SyncStatus {
  switch (status) {
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

// ---- presence from other clients is untrusted: coerce to the expected shapes ----------

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function toPoint(v: unknown): Point | null {
  const p = v as { x?: unknown; y?: unknown } | null;
  return p && isNum(p.x) && isNum(p.y) ? { x: p.x, y: p.y } : null;
}

function toColor(v: unknown): Color | null {
  const c = v as { r?: unknown; g?: unknown; b?: unknown } | null;
  return c && isNum(c.r) && isNum(c.g) && isNum(c.b) ? { r: c.r, g: c.g, b: c.b } : null;
}

function toDraft(v: unknown): Presence["pencilDraft"] {
  if (!Array.isArray(v)) return null;
  return v
    .filter((p): p is number[] => Array.isArray(p) && p.length >= 2 && p.every(isNum))
    .map((p) => [p[0]!, p[1]!, p[2] ?? 0.5] as [number, number, number]);
}

export function toPresence(data: PresenceData): Presence {
  return {
    ...INITIAL_PRESENCE,
    cursor: toPoint(data.cursor),
    selection: Array.isArray(data.selection)
      ? data.selection.filter((s): s is string => typeof s === "string")
      : [],
    pencilDraft: toDraft(data.pencilDraft),
    penColor: toColor(data.penColor),
  };
}

/** Stable small numbers per connection key, for colours and React keys. */
class ConnectionIds {
  private readonly byKey = new Map<string, number>();
  private readonly used = new Set<number>();

  get(key: string): number {
    let id = this.byKey.get(key);
    if (id !== undefined) return id;
    // Hash so the same person tends to get the same colour in every tab.
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    id = h % 100_000;
    while (this.used.has(id)) id++;
    this.used.add(id);
    this.byKey.set(key, id);
    return id;
  }
}
