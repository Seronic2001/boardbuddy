import type { DurableState, PersistBatch } from "@boardbuddy/sync-core";
import type { BoardBatch, MultiBoardPersister, Persister } from "./persister";

type Waiting = BoardBatch & { resolve: () => void; reject: (err: unknown) => void };

export type GroupCommitOptions = {
  /** Transactions allowed in flight at once. Default 4. */
  concurrency?: number;
  /** Most boards in one transaction. Default 500. */
  maxBoardsPerTransaction?: number;
};

/**
 * Group commit across rooms. Every room flushes its own batch every few milliseconds, and
 * one transaction per room per flush tops out quickly (each costs several round trips and
 * a commit). Here at most `concurrency` transactions run at once. Writes that arrive while
 * they're all busy wait and go out together in the next free one, so the transaction rate
 * stays bounded as rooms are added and each transaction carries more boards. Under light
 * load a write starts at once.
 *
 * Every caller still gets its own promise that resolves only once its batch is durable,
 * which is all RoomHost relies on. A board's batches never share a transaction and go out
 * in order (RoomHost only has one write in flight anyway). If a combined transaction fails,
 * its batches are retried one by one, so a single bad batch fails only its own room.
 */
export class GroupCommitPersister implements Persister {
  private queue: Waiting[] = [];
  /** Boards with a transaction running; their next batch waits for it. */
  private readonly inFlight = new Set<string>();
  private running = 0;
  private scheduled = false;
  private readonly concurrency: number;
  private readonly maxBoards: number;
  private idle: (() => void)[] = [];

  constructor(
    private readonly inner: MultiBoardPersister,
    options: GroupCommitOptions = {},
  ) {
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.maxBoards = Math.max(1, options.maxBoardsPerTransaction ?? 500);
  }

  load(boardId: string): Promise<DurableState> {
    return this.inner.load(boardId);
  }

  write(boardId: string, batch: PersistBatch): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ boardId, batch, resolve, reject });
      this.schedule();
    });
  }

  async close(): Promise<void> {
    if (this.running > 0 || this.queue.length > 0) await new Promise<void>((r) => this.idle.push(r));
    await this.inner.close();
  }

  /** Starts transactions on the next turn, so writes issued in the same tick share one. */
  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const group = this.takeGroup();
      if (group.length === 0) break; // everything queued is for boards already in flight
      this.running++;
      void this.run(group).finally(() => {
        this.running--;
        if (this.queue.length > 0) this.pump();
        else if (this.running === 0) for (const r of this.idle.splice(0)) r();
      });
    }
  }

  private async run(group: Waiting[]): Promise<void> {
    try {
      await this.inner.writeMany(group);
      for (const w of group) w.resolve();
    } catch (err) {
      if (group.length === 1) group[0]!.reject(err);
      else await this.oneByOne(group);
    } finally {
      for (const w of group) this.inFlight.delete(w.boardId);
    }
  }

  /** Oldest first, one batch per board, skipping boards that have a transaction running. */
  private takeGroup(): Waiting[] {
    const group: Waiting[] = [];
    const rest: Waiting[] = [];
    const taken = new Set<string>();
    for (const w of this.queue) {
      if (group.length < this.maxBoards && !taken.has(w.boardId) && !this.inFlight.has(w.boardId)) {
        taken.add(w.boardId);
        group.push(w);
      } else {
        rest.push(w);
      }
    }
    for (const b of taken) this.inFlight.add(b);
    this.queue = rest;
    return group;
  }

  private async oneByOne(group: Waiting[]): Promise<void> {
    for (const w of group) {
      try {
        await this.inner.writeMany([w]);
        w.resolve();
      } catch (err) {
        w.reject(err);
      }
    }
  }
}
