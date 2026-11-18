import { apply, applyAll, DELETED_FIELD, emptyDoc, isVisible, mergeDocs, readLayer, type Doc, type Json, type LayerRecord, type Op } from "./doc";
import { Clock, ClockDriftError, compareHLC, encodeHLC, type ClockOptions, type HLC } from "./hlc";
import { History, type HistoryOptions } from "./history";

/**
 * One copy of a board: document, clock and local undo history. Pure state with no I/O.
 * The network layer sends the ops returned by mutate/undo/redo and passes incoming ops to
 * receive(). Changes are published through subscribe() (Observer), which fits React's
 * useSyncExternalStore.
 */

export interface Tx {
  readonly doc: Doc;
  read(layer: string): Record<string, Json> | undefined;
  create(layer: string, fields: Record<string, Json>): void;
  set(layer: string, field: string, v: Json): void;
  update(layer: string, fields: Record<string, Json>): void;
  delete(layer: string): void;
}

export type ReplicaOptions = ClockOptions & HistoryOptions & { doc?: Doc };

export class Replica {
  readonly clock: Clock;
  readonly history: History;
  private current: Doc;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly clientId: string,
    options: ReplicaOptions = {},
  ) {
    this.clock = new Clock(clientId, options);
    this.history = new History(options);
    this.current = options.doc ?? emptyDoc();
  }

  get doc(): Doc {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Run a local edit. Ops apply immediately and are recorded for undo. Returns ops to send. */
  mutate(fn: (tx: Tx) => void): Op[] {
    const before = this.current;
    const ops: Op[] = [];
    const emit = (op: Op) => {
      this.current = apply(this.current, op);
      ops.push(op);
    };
    const current = () => this.current;
    const tx: Tx = {
      get doc() {
        return current();
      },
      read: (layer) => readLayer(this.current, layer),
      create: (layer, fields) => emit({ kind: "create", layer, fields, ts: this.clock.tick() }),
      set: (layer, field, v) => emit({ kind: "set", layer, field, v, ts: this.clock.tick() }),
      update: (layer, fields) => {
        for (const [field, v] of Object.entries(fields)) tx.set(layer, field, v);
      },
      delete: (layer) => emit({ kind: "delete", layer, ts: this.clock.tick() }),
    };
    try {
      fn(tx);
    } catch (err) {
      this.current = before; // all-or-nothing
      throw err;
    }
    if (ops.length > 0) {
      this.history.record(before, ops);
      this.notify();
    }
    return ops;
  }

  /** Apply ops from other clients (or our own echoes; applying them twice is harmless). */
  receive(ops: readonly Op[]): void {
    for (const op of ops) this.observe(op.ts);
    const next = applyAll(this.current, ops);
    if (next !== this.current) {
      this.current = next;
      this.notify();
    }
  }

  /** Fold in a full document (a server snapshot). Local edits not yet in it are kept. */
  merge(doc: Doc): void {
    // Advance the clock past everything in the snapshot, so our next edit beats what we see.
    let newest: HLC | undefined;
    for (const record of doc.layers.values()) {
      for (const fv of Object.values(record.fields)) {
        if (!newest || compareHLC(fv.ts, newest) > 0) newest = fv.ts;
      }
    }
    if (newest) this.observe(newest);
    const next = mergeDocs(this.current, doc);
    if (next !== this.current) {
      this.current = next;
      this.notify();
    }
  }

  /**
   * Drop layers that `theirs` (an up-to-date server snapshot) doesn't have, except `keep`.
   * Used after merge(theirs): the server purged them, so keeping them would diverge.
   */
  forgetMissing(theirs: Doc, keep: ReadonlySet<string> = new Set()): void {
    let layers: Map<string, LayerRecord> | null = null;
    for (const id of this.current.layers.keys()) {
      if (theirs.layers.has(id) || keep.has(id)) continue;
      layers ??= new Map(this.current.layers);
      layers.delete(id);
    }
    if (layers) {
      this.current = { layers };
      this.notify();
    }
  }

  /**
   * New ops that re-assert every field where our copy is newer than `theirs` (a server that
   * lost history), skipping fields written by an op in `covered` (keys from encodeHLC).
   * Fresh timestamps let them through the server's authorship check; they change no values
   * here and are not undoable. Call after merge(theirs), so the clock is past everything.
   */
  reassert(theirs: Doc, covered: ReadonlySet<string> = new Set()): Op[] {
    const ops: Op[] = [];
    for (const [id, ours] of this.current.layers) {
      const other = theirs.layers.get(id);
      const newer = Object.entries(ours.fields).filter(([field, fv]) => {
        if (covered.has(encodeHLC(fv.ts))) return false;
        const theirsTs = other?.fields[field]?.ts;
        return !theirsTs || compareHLC(fv.ts, theirsTs) > 0;
      });
      if (newer.length === 0) continue;
      if (!other) {
        // A layer they never had: recreate it if it's visible (a lost tombstone needs nothing).
        if (isVisible(ours)) ops.push({ kind: "create", layer: id, fields: readLayer(this.current, id)!, ts: this.clock.tick() });
        continue;
      }
      for (const [field, fv] of newer) {
        const ts = this.clock.tick();
        if (field === DELETED_FIELD) ops.push({ kind: fv.v === true ? "delete" : "restore", layer: id, ts });
        else ops.push({ kind: "set", layer: id, field, v: fv.v, ts });
      }
    }
    return this.applyLocal(ops);
  }

  undo(): Op[] {
    return this.applyLocal(this.history.undo(this.current, () => this.clock.tick()));
  }

  redo(): Op[] {
    return this.applyLocal(this.history.redo(this.current, () => this.clock.tick()));
  }

  private applyLocal(ops: Op[]): Op[] {
    if (ops.length > 0) {
      this.current = applyAll(this.current, ops);
      this.notify();
    }
    return ops;
  }

  private observe(ts: HLC): void {
    try {
      this.clock.receive(ts);
    } catch (err) {
      // A skewed client must not drag our clock forward, but its op still merges so that
      // we converge with everyone else. The server rejects extreme skew before relaying.
      if (!(err instanceof ClockDriftError)) throw err;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
