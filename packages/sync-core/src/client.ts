import { docFromJSON, type Op } from "./doc";
import type { ClientMessage, PendingOp, ServerMessage } from "./protocol";
import type { Replica, Tx } from "./replica";

/**
 * Client side of the sync protocol. Pure state machine: the transport calls
 * onOpen/onClose/onMessage and delivers whatever is passed to `send`.
 *
 * - Local ops apply to the replica at once (optimistic) and wait in `pending` until acked.
 *   On every hello the whole pending queue is resent. The server dedups by cseq, so this is
 *   safe after any mix of drops, duplicates and reconnects.
 * - Server ops are applied in seq order. Ops that arrive early are buffered. A missing
 *   seq is filled by the next hello's catch-up (the transport sends one on reconnect and
 *   periodically while connected).
 * - Offline editing needs nothing extra: ops pile up in `pending` and go out on reconnect.
 *   (Persisting `pending` to IndexedDB across page reloads is the transport's job.)
 */

export type SyncClientState = {
  readonly lastSeq: number;
  readonly nextCseq: number;
  readonly pending: readonly PendingOp[];
};

export type SyncClientEvents = {
  onAck?: (upTo: number) => void;
  onError?: (cseq: number, message: string) => void;
};

export class SyncClient {
  private connected = false;
  private lastSeqValue = 0;
  private nextCseq = 1;
  private queue: PendingOp[] = [];
  private readonly early = new Map<number, Op>();

  constructor(
    readonly replica: Replica,
    private readonly send: (m: ClientMessage) => void,
    private readonly events: SyncClientEvents = {},
  ) {}

  get lastSeq(): number {
    return this.lastSeqValue;
  }

  get pending(): readonly PendingOp[] {
    return this.queue;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Queue state to persist next to the replica's doc (they must be saved together). */
  exportState(): SyncClientState {
    return { lastSeq: this.lastSeqValue, nextCseq: this.nextCseq, pending: this.queue };
  }

  /**
   * Resume a saved session before connecting. The replica must already hold the saved doc,
   * which includes the pending ops' effects. Pending ops go out on the next hello.
   */
  restore(state: SyncClientState): void {
    if (this.connected || this.queue.length > 0 || this.nextCseq !== 1) {
      throw new Error("restore() must be called on a fresh, disconnected client");
    }
    this.lastSeqValue = state.lastSeq;
    this.queue = [...state.pending];
    const highest = state.pending.at(-1)?.cseq ?? 0;
    this.nextCseq = Math.max(state.nextCseq, highest + 1);
    for (const p of state.pending) this.replica.receive([p.op]); // advances the clock past them
  }

  mutate(fn: (tx: Tx) => void): Op[] {
    return this.enqueue(this.replica.mutate(fn));
  }

  undo(): Op[] {
    return this.enqueue(this.replica.undo());
  }

  redo(): Op[] {
    return this.enqueue(this.replica.redo());
  }

  onOpen(): void {
    this.connected = true;
    this.hello();
  }

  onClose(): void {
    this.connected = false;
  }

  /** Resync heartbeat: fills gaps left by lost messages and resends unacked ops. */
  hello(): void {
    if (this.connected) this.send({ t: "hello", lastSeq: this.lastSeqValue, pending: this.queue });
  }

  onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        if (msg.catchup.kind === "snapshot") {
          const { snapshot } = msg.catchup;
          this.replica.merge(docFromJSON(snapshot.doc));
          if (snapshot.seq > this.lastSeqValue) this.lastSeqValue = snapshot.seq;
          this.drain();
        } else {
          this.ingest(msg.catchup.from, msg.catchup.ops);
        }
        break;
      case "ops":
        this.ingest(msg.seq, msg.batch);
        break;
      case "ack":
        this.queue = this.queue.filter((p) => p.cseq > msg.upTo);
        this.events.onAck?.(msg.upTo);
        break;
      case "error":
        this.events.onError?.(msg.cseq, msg.message);
        break;
    }
  }

  private enqueue(ops: Op[]): Op[] {
    if (ops.length === 0) return ops;
    const batch = ops.map((op) => ({ cseq: this.nextCseq++, op }));
    this.queue = [...this.queue, ...batch];
    if (this.connected) this.send({ t: "ops", batch });
    return ops;
  }

  private ingest(from: number, ops: readonly Op[]): void {
    ops.forEach((op, i) => {
      const seq = from + i;
      if (seq > this.lastSeqValue) this.early.set(seq, op);
    });
    this.drain();
  }

  private drain(): void {
    const ready: Op[] = [];
    while (this.early.has(this.lastSeqValue + 1)) {
      ready.push(this.early.get(this.lastSeqValue + 1)!);
      this.early.delete(++this.lastSeqValue);
    }
    for (const seq of this.early.keys()) if (seq <= this.lastSeqValue) this.early.delete(seq);
    if (ready.length > 0) this.replica.receive(ready);
  }
}
