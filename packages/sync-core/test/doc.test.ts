import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  apply,
  applyAll,
  canonical,
  emptyDoc,
  InvalidOpError,
  isVisible,
  readLayer,
  type Op,
} from "../src/doc";
import { compareHLC, type HLC } from "../src/hlc";
import { ops, reorderedWithDuplicates } from "./arbitraries";

const ts = (wall: number, client = "a", counter = 0): HLC => ({ wall, counter, client });

describe("apply: LWW registers", () => {
  it("newer write wins per field, older write is a no-op", () => {
    let d = apply(emptyDoc(), { kind: "create", layer: "l", fields: { x: 1, y: 1 }, ts: ts(1) });
    d = apply(d, { kind: "set", layer: "l", field: "x", v: 5, ts: ts(3) });
    const before = d;
    d = apply(d, { kind: "set", layer: "l", field: "x", v: 9, ts: ts(2, "b") });
    expect(d).toBe(before);
    expect(readLayer(d, "l")).toEqual({ x: 5, y: 1 });
  });

  it("concurrent edits to different fields both survive", () => {
    const base = apply(emptyDoc(), {
      kind: "create",
      layer: "l",
      fields: { x: 0, fill: "red" },
      ts: ts(1),
    });
    const move: Op = { kind: "set", layer: "l", field: "x", v: 50, ts: ts(5, "a") };
    const recolour: Op = { kind: "set", layer: "l", field: "fill", v: "blue", ts: ts(4, "b") };
    expect(readLayer(applyAll(base, [move, recolour]), "l")).toEqual({ x: 50, fill: "blue" });
    expect(readLayer(applyAll(base, [recolour, move]), "l")).toEqual({ x: 50, fill: "blue" });
  });

  it("same wall time is broken by counter, then client id", () => {
    const a: Op = { kind: "set", layer: "l", field: "x", v: "a", ts: ts(1, "a", 0) };
    const b: Op = { kind: "set", layer: "l", field: "x", v: "b", ts: ts(1, "b", 0) };
    const c: Op = { kind: "set", layer: "l", field: "x", v: "c", ts: ts(1, "a", 1) };
    expect(applyAll(emptyDoc(), [c, b, a]).layers.get("l")!.fields.x!.v).toBe("c");
    expect(applyAll(emptyDoc(), [a, b]).layers.get("l")!.fields.x!.v).toBe("b");
  });

  it("a set that arrives before its create is kept, and the layer appears once created", () => {
    let d = apply(emptyDoc(), { kind: "set", layer: "l", field: "x", v: 7, ts: ts(5) });
    expect(readLayer(d, "l")).toBeUndefined();
    d = apply(d, { kind: "create", layer: "l", fields: { x: 0, y: 0 }, ts: ts(1) });
    expect(readLayer(d, "l")).toEqual({ x: 7, y: 0 });
  });

  it("rejects writes to the reserved deleted field", () => {
    expect(() =>
      apply(emptyDoc(), { kind: "set", layer: "l", field: "deleted", v: false, ts: ts(1) }),
    ).toThrow(InvalidOpError);
    expect(() =>
      apply(emptyDoc(), { kind: "create", layer: "l", fields: { deleted: false }, ts: ts(1) }),
    ).toThrow(InvalidOpError);
  });
});

describe("apply: delete wins", () => {
  const create: Op = { kind: "create", layer: "l", fields: { x: 0, fill: "red" }, ts: ts(1) };
  const del: Op = { kind: "delete", layer: "l", ts: ts(5, "a") };

  it("a later edit does not bring a deleted layer back", () => {
    const edit: Op = { kind: "set", layer: "l", field: "x", v: 99, ts: ts(9, "b") };
    expect(readLayer(applyAll(emptyDoc(), [create, del, edit]), "l")).toBeUndefined();
  });

  it("restore brings it back with edits made while deleted, identically on every replica", () => {
    const edit: Op = { kind: "set", layer: "l", field: "fill", v: "blue", ts: ts(6, "b") };
    const restore: Op = { kind: "restore", layer: "l", ts: ts(8, "a") };
    const r1 = applyAll(emptyDoc(), [create, edit, del, restore]);
    const r2 = applyAll(emptyDoc(), [restore, del, create, edit]);
    expect(readLayer(r1, "l")).toEqual({ x: 0, fill: "blue" });
    expect(canonical(r1)).toBe(canonical(r2));
  });

  it("a create that arrives after a newer delete stays deleted", () => {
    expect(readLayer(applyAll(emptyDoc(), [del, create]), "l")).toBeUndefined();
  });
});

describe("apply: CRDT properties", () => {
  it("commutative: apply(apply(d, a), b) == apply(apply(d, b), a)", () => {
    fc.assert(
      fc.property(ops(20), ops(2), (prefix, pair) => {
        fc.pre(pair.length === 2);
        const d = applyAll(emptyDoc(), prefix);
        const [a, b] = pair as [Op, Op];
        expect(canonical(apply(apply(d, a), b))).toBe(canonical(apply(apply(d, b), a)));
      }),
      { numRuns: 500 },
    );
  });

  it("idempotent: apply(apply(d, a), a) == apply(d, a)", () => {
    fc.assert(
      fc.property(ops(20), ops(1), (prefix, single) => {
        fc.pre(single.length === 1);
        const once = apply(applyAll(emptyDoc(), prefix), single[0]!);
        expect(apply(once, single[0]!)).toBe(once);
      }),
      { numRuns: 500 },
    );
  });

  it("convergence: the same ops in any order with any duplicates give identical state", () => {
    fc.assert(
      fc.property(
        ops(60).chain((list) =>
          fc.tuple(fc.constant(list), reorderedWithDuplicates(list), reorderedWithDuplicates(list)),
        ),
        ([list, r1, r2]) => {
          const reference = canonical(applyAll(emptyDoc(), list));
          expect(canonical(applyAll(emptyDoc(), r1))).toBe(reference);
          expect(canonical(applyAll(emptyDoc(), r2))).toBe(reference);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("batches: two replicas exchanging their op sets end up identical", () => {
    fc.assert(
      fc.property(ops(30), ops(30), (left, right) => {
        // Re-stamp right so timestamps stay unique across both sets.
        const shifted = right.map((o) => ({ ...o, ts: { ...o.ts, counter: o.ts.counter + 1000 } }));
        const a = applyAll(applyAll(emptyDoc(), left), shifted);
        const b = applyAll(applyAll(emptyDoc(), shifted), left);
        expect(canonical(a)).toBe(canonical(b));
      }),
    );
  });

  it("visibility is decided only by the newest create/delete/restore", () => {
    fc.assert(
      fc.property(ops(60), (list) => {
        const d = applyAll(emptyDoc(), list);
        for (const id of new Set(list.map((o) => o.layer))) {
          const lifecycle = list
            .filter((o) => o.layer === id && o.kind !== "set")
            .sort((x, y) => compareHLC(x.ts, y.ts));
          const newest = lifecycle.at(-1);
          expect(isVisible(d.layers.get(id))).toBe(newest !== undefined && newest.kind !== "delete");
        }
      }),
    );
  });
});
