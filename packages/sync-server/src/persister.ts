import { InMemoryPersister, type DurableState, type PersistBatch } from "@boardbuddy/sync-core";

/**
 * Storage strategy for rooms. `write` must be atomic: either the whole batch is durable
 * or none of it is, because the room acks every op in the batch once it resolves.
 */
export interface Persister {
  load(boardId: string): Promise<DurableState>;
  write(boardId: string, batch: PersistBatch): Promise<void>;
  close(): Promise<void>;
}

export type BoardBatch = { readonly boardId: string; readonly batch: PersistBatch };

/** Storage that can make several boards' batches durable in one atomic step. */
export interface MultiBoardPersister extends Persister {
  writeMany(items: readonly BoardBatch[]): Promise<void>;
}

/** For tests and local development without a database. Data is lost on restart. */
export class MemoryPersister implements Persister {
  private readonly boards = new Map<string, InMemoryPersister>();

  async load(boardId: string): Promise<DurableState> {
    return this.board(boardId).load();
  }

  async write(boardId: string, batch: PersistBatch): Promise<void> {
    this.board(boardId).write(batch);
  }

  async close(): Promise<void> {}

  private board(boardId: string): InMemoryPersister {
    let store = this.boards.get(boardId);
    if (!store) {
      store = new InMemoryPersister();
      this.boards.set(boardId, store);
    }
    return store;
  }
}
