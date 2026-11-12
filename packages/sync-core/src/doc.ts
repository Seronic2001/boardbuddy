import { compareHLC, type HLC } from "./hlc";

/**
 * Document model: every layer is a bag of last-writer-wins registers, one per field.
 *
 * Merge rule: a write to (layer, field) takes effect only if its timestamp is greater than
 * the timestamp already stored there. That makes `apply` commutative, idempotent and
 * associative, so replicas that have seen the same set of ops hold identical state no
 * matter the order or how many duplicates they received.
 *
 * Deletion ("delete wins", see docs/adr/0001-delete-wins.md):
 *  - Visibility lives only in the reserved `deleted` register. Only `create`, `delete` and
 *    `restore` ops write it. A plain `set` never touches it, so editing a deleted layer
 *    cannot bring it back.
 *  - `set` ops on a deleted layer are still recorded in their registers. If we dropped them,
 *    the result would depend on whether the set arrived before or after the delete, and a
 *    later restore would show different states on different replicas.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type FieldValue = { readonly v: Json; readonly ts: HLC };

export type LayerRecord = {
  readonly id: string;
  readonly fields: Readonly<Record<string, FieldValue>>;
};

export type Doc = { readonly layers: ReadonlyMap<string, LayerRecord> };

export const DELETED_FIELD = "deleted";

export type CreateOp = {
  readonly kind: "create";
  readonly layer: string;
  readonly fields: Readonly<Record<string, Json>>;
  readonly ts: HLC;
};
export type SetOp = {
  readonly kind: "set";
  readonly layer: string;
  readonly field: string;
  readonly v: Json;
  readonly ts: HLC;
};
export type DeleteOp = { readonly kind: "delete"; readonly layer: string; readonly ts: HLC };
/** Only produced by undoing a delete. */
export type RestoreOp = { readonly kind: "restore"; readonly layer: string; readonly ts: HLC };

export type Op = CreateOp | SetOp | DeleteOp | RestoreOp;

export function emptyDoc(): Doc {
  return { layers: new Map() };
}

export class InvalidOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOpError";
  }
}

/** Structural checks shared by client and server. Wire-level validation (zod) is separate. */
export function assertValidOp(op: Op): void {
  if (op.layer.length === 0) throw new InvalidOpError("Op layer id must be non-empty");
  if (op.kind === "set" && op.field === DELETED_FIELD) {
    throw new InvalidOpError(`'${DELETED_FIELD}' may only be written by delete/restore ops`);
  }
  if (op.kind === "create" && Object.hasOwn(op.fields, DELETED_FIELD)) {
    throw new InvalidOpError(`create op must not include '${DELETED_FIELD}'`);
  }
}

/**
 * Pure merge. Returns the same Doc instance when the op changes nothing, so callers can
 * check `next !== prev` to see whether anything changed.
 */
export function apply(doc: Doc, op: Op): Doc {
  assertValidOp(op);
  const prev = doc.layers.get(op.layer);
  let record: LayerRecord = prev ?? { id: op.layer, fields: {} };

  switch (op.kind) {
    case "create":
      for (const [field, v] of Object.entries(op.fields)) {
        record = writeField(record, field, v, op.ts);
      }
      record = writeField(record, DELETED_FIELD, false, op.ts);
      break;
    case "set":
      record = writeField(record, op.field, op.v, op.ts);
      break;
    case "delete":
      record = writeField(record, DELETED_FIELD, true, op.ts);
      break;
    case "restore":
      record = writeField(record, DELETED_FIELD, false, op.ts);
      break;
  }

  if (record === prev) return doc;
  const layers = new Map(doc.layers);
  layers.set(op.layer, record);
  return { layers };
}

export function applyAll(doc: Doc, ops: Iterable<Op>): Doc {
  let next = doc;
  for (const op of ops) next = apply(next, op);
  return next;
}

function writeField(record: LayerRecord, field: string, v: Json, ts: HLC): LayerRecord {
  const existing = record.fields[field];
  // Equal timestamps mean the same op (timestamps are unique per client), so keep the existing value.
  if (existing && compareHLC(existing.ts, ts) >= 0) return record;
  return { id: record.id, fields: { ...record.fields, [field]: { v, ts } } };
}

// ---------------------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------------------

/** A layer is visible once it has been created and its latest delete/restore is not a delete. */
export function isVisible(record: LayerRecord | undefined): boolean {
  return record?.fields[DELETED_FIELD]?.v === false;
}

/** Plain field values of a visible layer, without the reserved `deleted` register. */
export function readLayer(doc: Doc, id: string): Record<string, Json> | undefined {
  const record = doc.layers.get(id);
  if (!record || !isVisible(record)) return undefined;
  const out: Record<string, Json> = {};
  for (const [field, fv] of Object.entries(record.fields)) {
    if (field !== DELETED_FIELD) out[field] = fv.v;
  }
  return out;
}

export function fieldTimestamp(doc: Doc, layer: string, field: string): HLC | undefined {
  return doc.layers.get(layer)?.fields[field]?.ts;
}

/**
 * Deterministic serialisation that ignores Map insertion order. Two replicas have converged
 * exactly when their canonical strings are equal, including timestamps and tombstones.
 */
export function canonical(doc: Doc): string {
  const ids = [...doc.layers.keys()].sort();
  const out = ids.map((id) => {
    const record = doc.layers.get(id)!;
    const names = Object.keys(record.fields).sort();
    return [
      id,
      names.map((n) => {
        const { v, ts } = record.fields[n]!;
        return [n, sortKeys(v), ts.wall, ts.counter, ts.client];
      }),
    ];
  });
  return JSON.stringify(out);
}

function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: { [key: string]: Json } = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]!);
    return out;
  }
  return v;
}
