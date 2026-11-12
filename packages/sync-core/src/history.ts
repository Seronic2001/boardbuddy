import { apply, DELETED_FIELD, type Doc, type Json, type Op } from "./doc";
import { hlcEquals, type HLC } from "./hlc";

/**
 * Multiplayer-aware undo/redo (Command pattern).
 *
 * A command is a list of field changes, each captured from the state before the edit. Undo
 * never rewrites history. It emits the old values as NEW ops with fresh timestamps, so they
 * merge like any other edit.
 *
 * Multiplayer rule: a change is undone only if the field still holds the write this
 * history expects (its timestamp is `ts`). If a teammate wrote the field since, that
 * field is skipped, so undo never reverts someone else's later work.
 *
 * Chaining: undoing a change writes a new timestamp, which would make an older command on
 * the same field look "overwritten by someone else". So every change also stores
 * `beforeTs`, the timestamp it overwrote. When change C is undone or redone at timestamp n,
 * the next older command on that field takes n as its expected timestamp, but only if its
 * write was the one C overwrote (`older.ts == C.beforeTs`). If a teammate's write came in
 * between, the chain is broken on purpose and the older change is skipped later.
 */

export type FieldChange = {
  readonly layer: string;
  readonly field: string;
  /** Value to write when this change is reversed. `undefined` = the field did not exist. */
  readonly before: Json | undefined;
  /** Timestamp of the value this change overwrote. */
  readonly beforeTs: HLC | undefined;
  readonly after: Json;
  /** Timestamp of the write this change made; the field must still hold it to be reversed. */
  ts: HLC;
};

export type Command = { changes: FieldChange[] };

export type HistoryOptions = { limit?: number };

const key = (layer: string, field: string) => `${layer}\u0000${field}`;

export class History {
  private readonly undoStack: Command[] = [];
  private readonly redoStack: Command[] = [];
  private open: Map<string, FieldChange> | null = null;
  private pauseDepth = 0;
  private readonly limit: number;

  constructor(options: HistoryOptions = {}) {
    this.limit = options.limit ?? 200;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0 || (this.open?.size ?? 0) > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Group every edit until the matching resume() into one command (drags, pen strokes). */
  pause(): void {
    if (this.pauseDepth++ === 0) this.open = new Map();
  }

  resume(): void {
    if (this.pauseDepth === 0) return;
    if (--this.pauseDepth === 0) this.closeOpen();
  }

  /**
   * Record local ops that were just applied to `before`. The ops must be the caller's own
   * new ops, not remote ops and not ops produced by undo()/redo().
   */
  record(before: Doc, ops: readonly Op[]): void {
    const batch = this.open ?? new Map<string, FieldChange>();
    let doc = before;
    for (const op of ops) {
      const next = apply(doc, op);
      if (next !== doc) {
        for (const field of writtenFields(op)) {
          const k = key(op.layer, field);
          const prevField = doc.layers.get(op.layer)?.fields[field];
          const nextField = next.layers.get(op.layer)!.fields[field]!;
          if (prevField === nextField) continue; // this field lost to a newer write
          const existing = batch.get(k);
          batch.set(k, {
            layer: op.layer,
            field,
            // Within one command, keep the first "before" and the last "after".
            before: existing ? existing.before : prevField?.v,
            beforeTs: existing ? existing.beforeTs : prevField?.ts,
            after: nextField.v,
            ts: nextField.ts,
          });
        }
      }
      doc = next;
    }
    if (batch.size > 0) this.redoStack.length = 0;
    if (!this.open) this.push(this.undoStack, compact(batch));
  }

  /** Ops that undo the newest command that still has something to undo. Apply and send them. */
  undo(doc: Doc, tick: () => HLC): Op[] {
    this.closeOpen();
    return this.reverse(doc, tick, this.undoStack, this.redoStack);
  }

  redo(doc: Doc, tick: () => HLC): Op[] {
    this.closeOpen();
    return this.reverse(doc, tick, this.redoStack, this.undoStack);
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.open = this.pauseDepth > 0 ? new Map() : null;
  }

  private reverse(doc: Doc, tick: () => HLC, from: Command[], to: Command[]): Op[] {
    // Commands whose every field was overwritten by teammates are dropped, and we move on
    // to the next one, so pressing undo always does something if anything can be undone.
    while (from.length > 0) {
      const command = from.pop()!;
      const ops: Op[] = [];
      const inverse: FieldChange[] = [];
      for (const change of command.changes) {
        const current = doc.layers.get(change.layer)?.fields[change.field];
        if (!current || !hlcEquals(current.ts, change.ts)) continue;
        const ts = tick();
        ops.push(writeOp(change.layer, change.field, change.before, ts));
        this.chain(from, change, ts);
        inverse.push({
          layer: change.layer,
          field: change.field,
          before: change.after,
          beforeTs: change.ts,
          after: change.before ?? null,
          ts,
        });
      }
      if (ops.length > 0) {
        this.push(to, { changes: inverse });
        return ops;
      }
    }
    return [];
  }

  private chain(stack: Command[], change: FieldChange, ts: HLC): void {
    if (!change.beforeTs) return;
    for (let i = stack.length - 1; i >= 0; i--) {
      const older = stack[i]!.changes.find(
        (c) => c.layer === change.layer && c.field === change.field,
      );
      if (!older) continue;
      if (hlcEquals(older.ts, change.beforeTs)) older.ts = ts;
      return;
    }
  }

  private closeOpen(): void {
    if (!this.open) return;
    const batch = this.open;
    this.open = this.pauseDepth > 0 ? new Map() : null;
    this.push(this.undoStack, compact(batch));
  }

  private push(stack: Command[], command: Command): void {
    if (command.changes.length === 0) return;
    stack.push(command);
    if (stack.length > this.limit) stack.shift();
  }
}

/**
 * Fields that an op writes, as far as undo cares. A create is undone by deleting the layer,
 * so only its lifecycle register is tracked.
 */
function writtenFields(op: Op): string[] {
  return op.kind === "set" ? [op.field] : [DELETED_FIELD];
}

/** Drop field edits on layers created inside the same command: undoing the create hides them. */
function compact(batch: Map<string, FieldChange>): Command {
  const created = new Set<string>();
  for (const c of batch.values()) {
    if (c.field === DELETED_FIELD && c.before === undefined) created.add(c.layer);
  }
  return {
    changes: [...batch.values()].filter(
      (c) => c.field === DELETED_FIELD || !created.has(c.layer),
    ),
  };
}

function writeOp(layer: string, field: string, v: Json | undefined, ts: HLC): Op {
  if (field === DELETED_FIELD) {
    // Undoing a create (before = undefined) or a restore (true) deletes the layer.
    return v === false ? { kind: "restore", layer, ts } : { kind: "delete", layer, ts };
  }
  // An LWW register can't be removed, so a field that did not exist before becomes null.
  return { kind: "set", layer, field, v: v ?? null, ts };
}
