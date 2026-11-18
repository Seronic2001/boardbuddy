import {
  applyAll,
  assertValidOp,
  docFromJSON,
  docToJSON,
  emptyDoc,
  expiredTombstones,
  type Doc,
  type Op,
} from "./doc";
import { Clock, compareHLC, type HLC } from "./hlc";
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
 *
 * Tombstone cleanup: whenever a snapshot is due, deleted layers untouched for
 * `tombstoneTtlMs` get a server-authored `purge` op appended to the batch, so the snapshot
 * no longer holds them and the purge reaches clients in sequence like any op. From then on
 * an op on that layer (from a client offline longer than the window) is rejected with
 * LAYER_GONE instead of resurrecting a partial record. A client that falls back to a
 * snapshot drops layers the snapshot doesn't have (see client.ts).
 */

/** Rejection message for ops on a layer the room doesn't have (purged, or never created). */
export const LAYER_GONE = "LAYER_GONE";
/** Author of purge ops. Real client ids are `${userId}~${tab}`, so this can't collide. */
export const SERVER_CLIENT = "~server";
export const DEFAULT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  /**
   * Extra per-op checks (authorship, clock skew, layer cap). Return an error message to
   * reject. Rejected ops still use up their cseq, so the client queue keeps moving.
   */
  validate?: (op: Op, client: string, committed: Doc) => string | null;
  /** Deleted layers untouched this long are purged at the next snapshot. Default 30 days. */
  tombstoneTtlMs?: number;
  /** Physical time, for tombstone expiry and purge timestamps. */
  now?: () => number;
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
  /** Timestamps of the ops at snapshotSeq and head, when known (older snapshots lack it). */
  private snapshotTs: HLC | undefined;
  private headTs: HLC | undefined;

  /** Accepted but not yet durable. */
  private nextSeq: number;
  private acceptedCseqs: Map<string, number>;
  private buffer: LogEntry[] = [];
  private rejections: Rejection[] = [];
  private inFlight: { batch: PersistBatch; rejections: Rejection[] } | null = null;

  private readonly catchupWindow: number;
  private readonly snapshotEvery: number;
  private readonly maxBatch: number;
  private readonly validate: RoomOptions["validate"];
  private readonly tombstoneTtlMs: number;
  private readonly now: () => number;
  private readonly clock: Clock;

  constructor(state: DurableState = { entries: [], cseqs: {} }, options: RoomOptions = {}) {
    this.catchupWindow = options.catchupWindow ?? 2_000;
    this.snapshotEvery = options.snapshotEvery ?? 500;
    this.maxBatch = options.maxBatch ?? 1_000;
    this.validate = options.validate;
    this.tombstoneTtlMs = options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.clock = new Clock(SERVER_CLIENT, { now: this.now });

    const base = state.snapshot ? docFromJSON(state.snapshot.doc) : emptyDoc();
    this.snapshotSeq = state.snapshot?.seq ?? 0;
    this.snapshotTs = state.snapshot?.headTs;
    const entries = state.entries
      .filter((e) => e.seq > this.snapshotSeq)
      .sort((a, b) => a.seq - b.seq);
    entries.forEach((e, i) => {
      if (e.seq !== this.snapshotSeq + i + 1) throw new Error(`Log gap before seq ${e.seq}`);
    });
    this.doc = applyAll(base, entries.map((e) => e.op));
    this.head = entries.at(-1)?.seq ?? this.snapshotSeq;
    this.headTs = entries.at(-1)?.op.ts ?? this.snapshotTs;
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
      // The queue first: the client may answer the welcome with new ops straight away,
      // and they have to follow the queue's cseqs.
      this.skipForgottenCseqs(client, msg.pending[0]?.cseq ?? msg.nextCseq);
      this.accept(client, msg.pending, send);
      send(this.welcome(msg.lastSeq, msg.lastTs));
    } else {
      this.accept(client, msg.batch, send);
    }
  }

  // -------------------------------------------------------------------------------------
  // Persistence handshake
  // -------------------------------------------------------------------------------------

  /**
   * Next write to make durable, or null if there is nothing to write or a write is in flight.
   * `compact` forces a snapshot (and tombstone cleanup) even below `snapshotEvery`, e.g.
   * when the room goes idle; it returns null only if that would change nothing.
   */
  takeBatch({ compact = false }: { compact?: boolean } = {}): PersistBatch | null {
    if (this.inFlight) return null;
    const nothingNew = this.buffer.length === 0 && this.rejections.length === 0;
    if (nothingNew && !compact) return null;
    let entries = this.buffer;
    const accepted = entries.at(-1)?.seq ?? this.head;
    const cseqs = Object.fromEntries(this.acceptedCseqs);
    let snapshot: Snapshot | undefined;
    if (compact || accepted - this.snapshotSeq >= this.snapshotEvery) {
      let doc = applyAll(this.doc, entries.map((e) => e.op));
      const purges: LogEntry[] = expiredTombstones(doc, this.now() - this.tombstoneTtlMs).map((layer) => {
        const seq = this.nextSeq++;
        return { seq, client: SERVER_CLIENT, cseq: seq, op: { kind: "purge", layer, ts: this.clock.tick() } };
      });
      if (nothingNew && purges.length === 0 && accepted === this.snapshotSeq) return null;
      if (purges.length > 0) {
        entries = [...entries, ...purges];
        doc = applyAll(doc, purges.map((e) => e.op));
      }
      const lastSeq = entries.at(-1)?.seq ?? this.head;
      const headTs = entries.at(-1)?.op.ts ?? this.headTs;
      snapshot = { seq: lastSeq, doc: docToJSON(doc), cseqs, ...(headTs ? { headTs } : {}) };
    }
    this.buffer = [];
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
    if (batch.entries.length > 0) {
      this.head = batch.entries.at(-1)!.seq;
      this.headTs = batch.entries.at(-1)!.op.ts;
    }
    this.recent.push(...batch.entries);
    if (this.recent.length > this.catchupWindow) {
      this.recent.splice(0, this.recent.length - this.catchupWindow);
    }
    if (batch.snapshot) {
      this.snapshotSeq = batch.snapshot.seq;
      this.snapshotTs = batch.snapshot.headTs;
    }

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

  private welcome(lastSeq: number, lastTs: HLC | undefined): ServerMessage {
    const reset = this.historyDiffers(lastSeq, lastTs);
    const oldest = this.recent[0]?.seq ?? this.head + 1;
    const inWindow = !reset && lastSeq <= this.head && lastSeq >= Math.min(oldest, this.head + 1) - 1;
    if (inWindow) {
      const ops = this.recent.filter((e) => e.seq > lastSeq).map((e) => e.op);
      return { t: "welcome", seq: this.head, catchup: { kind: "ops", from: lastSeq + 1, ops } };
    }
    const snapshot: Snapshot = {
      seq: this.head,
      doc: docToJSON(this.doc),
      cseqs: Object.fromEntries(this.durableCseqs),
      ...(this.headTs ? { headTs: this.headTs } : {}),
    };
    return { t: "welcome", seq: this.head, catchup: reset ? { kind: "snapshot", snapshot, reset } : { kind: "snapshot", snapshot } };
  }

  /**
   * True when the client has seen a history this room doesn't have: its lastSeq is beyond
   * our head, or our op at that seq isn't the one it saw. Only a server restored from an
   * older backup does that. If we can't tell (an old client, or a seq we no longer hold
   * the timestamp for), assume all is well, as before.
   */
  private historyDiffers(lastSeq: number, lastTs: HLC | undefined): boolean {
    if (lastSeq > this.head) return true;
    if (lastSeq === 0 || !lastTs) return false;
    const ours = this.tsAt(lastSeq);
    return ours !== undefined && compareHLC(ours, lastTs) !== 0;
  }

  private tsAt(seq: number): HLC | undefined {
    const first = this.recent[0]?.seq;
    if (first !== undefined && seq >= first && seq <= this.head) return this.recent[seq - first]!.op.ts;
    if (seq === this.head) return this.headTs;
    if (seq === this.snapshotSeq) return this.snapshotTs;
    return undefined;
  }

  /**
   * At hello, a client's oldest unacked cseq (or, with nothing pending, its next cseq) is
   * never more than one past what we have, because it only drops ops we acked. A bigger
   * gap means we lost acked ops (restored from a backup), so continue from there instead of
   * waiting for cseqs that will never come. A client can only skip its own numbers.
   */
  private skipForgottenCseqs(client: string, base: number | undefined): void {
    if (base === undefined || !Number.isInteger(base)) return;
    if (base - 1 > (this.acceptedCseqs.get(client) ?? 0)) this.acceptedCseqs.set(client, base - 1);
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
        if (op.kind === "purge") throw new Error("purge ops are server-only");
        // Every layer a client can see was created through this room, so an unknown one
        // was purged (or its create rejected). Applying the op would leave a stray record.
        if (op.kind !== "create" && !this.layerExists(op.layer)) throw new Error(LAYER_GONE);
        const problem = this.validate?.(op, client, this.doc);
        if (problem !== null && problem !== undefined) throw new Error(problem);
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

  /** Whether `layer` exists once everything accepted so far is applied. */
  private layerExists(layer: string): boolean {
    let exists = this.doc.layers.has(layer);
    const scan = (entries: readonly LogEntry[]) => {
      for (const e of entries) if (e.op.layer === layer) exists = e.op.kind !== "purge";
    };
    if (this.inFlight) scan(this.inFlight.batch.entries);
    scan(this.buffer);
    return exists;
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
