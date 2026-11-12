import { docFromJSON, type Op } from "./doc";
import { encodeHLC, type HLC } from "./hlc";
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
  /** Timestamp of the op at lastSeq; lets the server spot a history it doesn't have. */
  readonly lastTs?: HLC;
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
  private lastTsValue: HLC | undefined;
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

  get lastTs(): HLC | undefined {
    return this.lastTsValue;
  }

  get pending(): readonly PendingOp[] {
    return this.queue;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Queue state to persist next to the replica's doc (they must be saved together). */
  exportState(): SyncClientState {
    const state = { lastSeq: this.lastSeqValue, nextCseq: this.nextCseq, pending: this.queue };
    return this.lastTsValue ? { ...state, lastTs: this.lastTsValue } : state;
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
    this.lastTsValue = state.lastTs;
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
    if (!this.connected) return;
    this.send({
      t: "hello",
      lastSeq: this.lastSeqValue,
      pending: this.queue,
      nextCseq: this.nextCseq,
      ...(this.lastTsValue ? { lastTs: this.lastTsValue } : {}),
    });
  }

  onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        if (msg.catchup.kind === "snapshot") {
          const { snapshot } = msg.catchup;
          const serverDoc = docFromJSON(snapshot.doc);
          this.replica.merge(serverDoc);
          // Only the room's flag: a snapshot older than lastSeq on its own may just be a
          // stale welcome (a resync heartbeat's answer overtaken by newer ops).
          if (msg.catchup.reset) {
            this.resetTo(snapshot.seq, snapshot.headTs, serverDoc);
          } else if (snapshot.seq > this.lastSeqValue) {
            this.lastSeqValue = snapshot.seq;
            this.lastTsValue = snapshot.headTs;
          }
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

  /**
   * The server lost history we saw (restored from a backup). Take its position, so we
   * don't skip the seqs it now uses for other ops, and send back as our own new edits
   * every field where our copy is newer than its copy. Those are the edits it lost. Each
   * one only wins where nothing newer exists, so nobody's later work is overwritten.
   * Fields our pending ops already cover go out with the queue.
   */
  private resetTo(seq: number, ts: HLC | undefined, serverDoc: ReturnType<typeof docFromJSON>): void {
    this.early.clear();
    this.lastSeqValue = seq;
    this.lastTsValue = ts;
    const covered = new Set(this.queue.map((p) => encodeHLC(p.op.ts)));
    this.enqueue(this.replica.reassert(serverDoc, covered));
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
      const op = this.early.get(this.lastSeqValue + 1)!;
      ready.push(op);
      this.lastTsValue = op.ts;
      this.early.delete(++this.lastSeqValue);
    }
    for (const seq of this.early.keys()) if (seq <= this.lastSeqValue) this.early.delete(seq);
    if (ready.length > 0) this.replica.receive(ready);
  }
}
