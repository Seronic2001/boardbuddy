import {
  applyAll,
  assertValidOp,
  docFromJSON,
  docToJSON,
  emptyDoc,
  type Doc,
  type Op,
} from "./doc";
import type { ClientMessage, PendingOp, ServerMessage, Snapshot } from "./protocol";

/**
 * Server side of one board (Mediator: sessions only ever talk to the Room). Pure state
 * machine: the transport calls connect/receive/disconnect, and the persistence layer calls
 * takeBatch() → (durable write) → commit(). No I/O happens here.
 *
 * The room validates and sequences ops but never transforms them: merge is commutative and
 * idempotent, so the server's job is ordering, durability and fan-out.
 *
 * Durability rule: an op is acked and broadcast only after commit(), meaning after the
 * write that contains it is durable. If seqs were exposed before that, a crash could reuse
 * them for different ops, and a client whose lastSeq covered them would silently skip the
 * replacements.
 */

export type LogEntry = {
  readonly seq: number;
  readonly client: string;
  readonly cseq: number;
  readonly op: Op;
};

export type PersistBatch = {
  readonly entries: readonly LogEntry[];
  /** cseq high-water marks after this batch (includes rejected ops). */
  readonly cseqs: Readonly<Record<string, number>>;
  /** Present every `snapshotEvery` ops; lets storage drop older log entries. */
  readonly snapshot?: Snapshot;
};

export type DurableState = {
  readonly snapshot?: Snapshot;
  readonly entries: readonly LogEntry[];
  readonly cseqs: Readonly<Record<string, number>>;
};

export type RoomOptions = {
  /** Committed entries kept in memory for catch-up. Further behind → snapshot. */
  catchupWindow?: number;
  snapshotEvery?: number;
  /** Reject a batch outright above this size (wire-level DoS guard). */
  maxBatch?: number;
};

type Rejection = { client: string; cseq: number; message: string };

export class Room {
  private readonly sessions = new Map<string, (m: ServerMessage) => void>();

  /** State as of the last commit: what clients may see. */
  private doc: Doc;
  private head: number;
  private readonly recent: LogEntry[] = [];
  private durableCseqs: Map<string, number>;
  private snapshotSeq: number;

  /** Accepted but not yet durable. */
  private nextSeq: number;
  private acceptedCseqs: Map<string, number>;
  private buffer: LogEntry[] = [];
  private rejections: Rejection[] = [];
  private inFlight: { batch: PersistBatch; rejections: Rejection[] } | null = null;

  private readonly catchupWindow: number;
  private readonly snapshotEvery: number;
  private readonly maxBatch: number;

  constructor(state: DurableState = { entries: [], cseqs: {} }, options: RoomOptions = {}) {
    this.catchupWindow = options.catchupWindow ?? 2_000;
    this.snapshotEvery = options.snapshotEvery ?? 500;
    this.maxBatch = options.maxBatch ?? 1_000;

    const base = state.snapshot ? docFromJSON(state.snapshot.doc) : emptyDoc();
    this.snapshotSeq = state.snapshot?.seq ?? 0;
    const entries = state.entries
      .filter((e) => e.seq > this.snapshotSeq)
      .sort((a, b) => a.seq - b.seq);
    entries.forEach((e, i) => {
      if (e.seq !== this.snapshotSeq + i + 1) throw new Error(`Log gap before seq ${e.seq}`);
    });
    this.doc = applyAll(base, entries.map((e) => e.op));
    this.head = entries.at(-1)?.seq ?? this.snapshotSeq;
    this.recent.push(...entries.slice(-this.catchupWindow));
    this.durableCseqs = new Map(Object.entries({ ...state.snapshot?.cseqs, ...state.cseqs }));
    this.acceptedCseqs = new Map(this.durableCseqs);
    this.nextSeq = this.head + 1;
  }

  get seq(): number {
    return this.head;
  }

  get committedDoc(): Doc {
    return this.doc;
  }

  durableCseq(client: string): number {
    return this.durableCseqs.get(client) ?? 0;
  }

  connect(client: string, send: (m: ServerMessage) => void): void {
    this.sessions.set(client, send);
  }

  disconnect(client: string): void {
    this.sessions.delete(client);
  }

  receive(client: string, msg: ClientMessage): void {
    const send = this.sessions.get(client);
    if (!send) return;
    if (msg.t === "hello") {
      send(this.welcome(msg.lastSeq));
      this.accept(client, msg.pending, send);
    } else {
      this.accept(client, msg.batch, send);
    }
  }

  // -------------------------------------------------------------------------------------
  // Persistence handshake
  // -------------------------------------------------------------------------------------

  /** Next write to make durable, or null if there is nothing to write or a write is in flight. */
  takeBatch(): PersistBatch | null {
    if (this.inFlight || (this.buffer.length === 0 && this.rejections.length === 0)) return null;
    const entries = this.buffer;
    this.buffer = [];
    const lastSeq = entries.at(-1)?.seq ?? this.head;
    const cseqs = Object.fromEntries(this.acceptedCseqs);
    let snapshot: Snapshot | undefined;
    if (lastSeq - this.snapshotSeq >= this.snapshotEvery) {
      const doc = applyAll(this.doc, entries.map((e) => e.op));
      snapshot = { seq: lastSeq, doc: docToJSON(doc), cseqs };
    }
    const batch: PersistBatch = snapshot ? { entries, cseqs, snapshot } : { entries, cseqs };
    this.inFlight = { batch, rejections: this.rejections };
    this.rejections = [];
    return batch;
  }

  /** Call once `batch` is durable. Updates committed state, acks authors, broadcasts. */
  commit(batch: PersistBatch): void {
    if (!this.inFlight || this.inFlight.batch !== batch) {
      throw new Error("commit() called with a batch that is not in flight");
    }
    const { rejections } = this.inFlight;
    this.inFlight = null;

    const ops = batch.entries.map((e) => e.op);
    this.doc = applyAll(this.doc, ops);
    if (batch.entries.length > 0) this.head = batch.entries.at(-1)!.seq;
    this.recent.push(...batch.entries);
    if (this.recent.length > this.catchupWindow) {
      this.recent.splice(0, this.recent.length - this.catchupWindow);
    }
    if (batch.snapshot) this.snapshotSeq = batch.snapshot.seq;

    const changed = new Set<string>();
    for (const [client, cseq] of Object.entries(batch.cseqs)) {
      if (cseq > (this.durableCseqs.get(client) ?? 0)) {
        this.durableCseqs.set(client, cseq);
        changed.add(client);
      }
    }
    for (const r of rejections) {
      this.sessions.get(r.client)?.({ t: "error", code: "INVALID_OP", cseq: r.cseq, message: r.message });
    }
    for (const client of changed) {
      this.sessions.get(client)?.({ t: "ack", upTo: this.durableCseqs.get(client)!, seq: this.head });
    }
    if (ops.length > 0) {
      const msg: ServerMessage = { t: "ops", seq: batch.entries[0]!.seq, batch: ops };
      for (const send of this.sessions.values()) send(msg);
    }
  }

  // -------------------------------------------------------------------------------------

  private welcome(lastSeq: number): ServerMessage {
    const oldest = this.recent[0]?.seq ?? this.head + 1;
    const inWindow = lastSeq <= this.head && lastSeq >= Math.min(oldest, this.head + 1) - 1;
    if (inWindow) {
      const ops = this.recent.filter((e) => e.seq > lastSeq).map((e) => e.op);
      return { t: "welcome", seq: this.head, catchup: { kind: "ops", from: lastSeq + 1, ops } };
    }
    return {
      t: "welcome",
      seq: this.head,
      catchup: {
        kind: "snapshot",
        snapshot: { seq: this.head, doc: docToJSON(this.doc), cseqs: Object.fromEntries(this.durableCseqs) },
      },
    };
  }

  private accept(client: string, batch: readonly PendingOp[], send: (m: ServerMessage) => void): void {
    if (batch.length > this.maxBatch) {
      send({ t: "error", code: "INVALID_OP", cseq: batch[0]?.cseq ?? 0, message: "Batch too large" });
      return;
    }
    let accepted = this.acceptedCseqs.get(client) ?? 0;
    for (const { cseq, op } of batch) {
      if (cseq <= accepted) continue; // duplicate: already accepted (maybe not yet durable)
      if (cseq !== accepted + 1) break; // gap: the client resends from its oldest pending op
      accepted = cseq;
      try {
        assertValidOp(op);
        this.buffer.push({ seq: this.nextSeq++, client, cseq, op });
      } catch (err) {
        this.rejections.push({ client, cseq, message: (err as Error).message });
      }
    }
    this.acceptedCseqs.set(client, accepted);
    // Resent ops that are already durable: re-ack so the client can clear its queue.
    const durable = this.durableCseqs.get(client) ?? 0;
    if (batch.length > 0 && batch[0]!.cseq <= durable) {
      send({ t: "ack", upTo: durable, seq: this.head });
    }
  }
}

/** Strategy for tests and the simulator; the Postgres persister implements the same contract. */
export class InMemoryPersister {
  private snapshot: Snapshot | undefined;
  private entries: LogEntry[] = [];
  private cseqs: Record<string, number> = {};

  write(batch: PersistBatch): void {
    this.entries.push(...batch.entries);
    this.cseqs = { ...this.cseqs, ...batch.cseqs };
    if (batch.snapshot) {
      this.snapshot = batch.snapshot;
      const cut = batch.snapshot.seq;
      this.entries = this.entries.filter((e) => e.seq > cut);
    }
  }

  load(): DurableState {
    const state = { entries: [...this.entries], cseqs: { ...this.cseqs } };
    return this.snapshot ? { ...state, snapshot: this.snapshot } : state;
  }

  get logLength(): number {
    return this.entries.length;
  }
}
