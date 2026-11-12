import { apply, applyAll, emptyDoc, readLayer, type Doc, type Json, type Op } from "./doc";
import { Clock, ClockDriftError, type ClockOptions } from "./hlc";
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
    const replica = this;
    const tx: Tx = {
      get doc() {
        return replica.current;
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
    for (const op of ops) {
      try {
        this.clock.receive(op.ts);
      } catch (err) {
        // A skewed client must not drag our clock forward, but its op still merges so that
        // we converge with everyone else. The server rejects extreme skew before relaying.
        if (!(err instanceof ClockDriftError)) throw err;
      }
    }
    const next = applyAll(this.current, ops);
    if (next !== this.current) {
      this.current = next;
      this.notify();
    }
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

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
