import type { DocJSON, PendingOp } from "@boardbuddy/sync-core";

/**
 * Offline persistence. A saved session is one tab identity's state for one board: the
 * replica's doc, the server position it reflects, and the queue of unacked ops. Saving
 * them together keeps them consistent; the doc already contains the pending ops' effects.
 *
 * Identity: unacked ops are stamped with `${userId}~${tabId}`, and the server only accepts
 * them from that identity. So a reloaded tab must take over its old identity, and two
 * open tabs must never share one. Each identity is held by a Web Lock for as long as a
 * tab uses it; a new page load adopts a saved identity whose lock is free.
 */

export type SavedSession = {
  boardId: string;
  userId: string;
  tabId: string;
  doc: DocJSON;
  lastSeq: number;
  nextCseq: number;
  pending: PendingOp[];
  savedAt: number;
};

export interface OfflineStore {
  list(boardId: string, userId: string): Promise<SavedSession[]>;
  save(session: SavedSession): Promise<void>;
  delete(boardId: string, tabId: string): Promise<void>;
}

/** The part of navigator.locks we use. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<void> | void,
  ): Promise<unknown>;
}

/** Holds the lock until the returned release() is called; null if someone else holds it. */
export function tryLock(locks: LockManagerLike, name: string): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    void locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return;
      }
      return new Promise<void>((release) => resolve(release));
    });
  });
}

export const lockName = (boardId: string, tabId: string) => `buddysync:${boardId}:${tabId}`;

const DB_NAME = "buddysync";
const STORE = "sessions";

/** IndexedDB implementation. One object store keyed by [boardId, tabId]. */
export class IndexedDbStore implements OfflineStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {}

  async list(boardId: string, userId: string): Promise<SavedSession[]> {
    const db = await this.open();
    const all = await request<SavedSession[]>(
      db.transaction(STORE, "readonly").objectStore(STORE).index("byBoardUser").getAll([boardId, userId]),
    );
    return all;
  }

  async save(session: SavedSession): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(session);
    await done(tx);
  }

  async delete(boardId: string, tabId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete([boardId, tabId]);
    await done(tx);
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = this.factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: ["boardId", "tabId"] });
        store.createIndex("byBoardUser", ["boardId", "userId"]);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
