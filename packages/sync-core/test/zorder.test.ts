import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { apply, applyAll, emptyDoc, type Doc, type Op } from "../src/doc";
import {
  isValidKey,
  keyBetween,
  keysBetween,
  orderedLayerIds,
  zKeyAbove,
  zKeyBottom,
  zKeyTop,
} from "../src/zorder";

describe("keyBetween", () => {
  it("handles open bounds", () => {
    const mid = keyBetween(null, null);
    expect(keyBetween(null, mid) < mid).toBe(true);
    expect(keyBetween(mid, null) > mid).toBe(true);
  });

  it("rejects a >= b and invalid keys", () => {
    expect(() => keyBetween("V", "V")).toThrow();
    expect(() => keyBetween("b", "a")).toThrow();
    expect(() => keyBetween("a0", null)).toThrow();
    expect(() => keyBetween("a!", null)).toThrow();
  });

  it("property: random insertions always produce a valid key strictly between its neighbours", () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 300 }), (choices) => {
        const keys: string[] = [];
        for (const c of choices) {
          const i = c % (keys.length + 1);
          const k = keyBetween(keys[i - 1] ?? null, keys[i] ?? null);
          expect(isValidKey(k)).toBe(true);
          if (i > 0) expect(k > keys[i - 1]!).toBe(true);
          if (i < keys.length) expect(k < keys[i]!).toBe(true);
          keys.splice(i, 0, k);
        }
      }),
    );
  });

  it("1,000 bring-to-front or send-to-back moves keep keys short and ordered", () => {
    let top: string | null = null;
    let bottom: string | null = null;
    for (let i = 0; i < 1000; i++) {
      const nextTop = keyBetween(top, null);
      const nextBottom = keyBetween(null, bottom);
      if (top !== null) expect(nextTop > top).toBe(true);
      if (bottom !== null) expect(nextBottom < bottom).toBe(true);
      expect(isValidKey(nextTop) && isValidKey(nextBottom)).toBe(true);
      top = nextTop;
      bottom = nextBottom;
    }
    expect(top!.length).toBeLessThan(40);
    expect(bottom!.length).toBeLessThan(40);
  });

  it("keysBetween returns n sorted keys inside the bounds", () => {
    const keys = keysBetween("A", "B", 50);
    expect(keys).toHaveLength(50);
    expect([...keys].sort()).toEqual(keys);
    expect(new Set(keys).size).toBe(50);
    expect(keys[0]! > "A" && keys.at(-1)! < "B").toBe(true);
  });
});

describe("z-order on a Doc", () => {
  let wall = 0;
  const create = (layer: string, z: string): Op => ({
    kind: "create",
    layer,
    fields: { z },
    ts: { wall: ++wall, counter: 0, client: "a" },
  });
  const setZ = (layer: string, z: string): Op => ({
    kind: "set",
    layer,
    field: "z",
    v: z,
    ts: { wall: ++wall, counter: 0, client: "a" },
  });

  function board(): Doc {
    const [a, b, c] = keysBetween(null, null, 3) as [string, string, string];
    return applyAll(emptyDoc(), [create("A", a), create("B", b), create("C", c)]);
  }

  it("orders by z, hides deleted layers", () => {
    let d = board();
    expect(orderedLayerIds(d)).toEqual(["A", "B", "C"]);
    d = apply(d, { kind: "delete", layer: "B", ts: { wall: ++wall, counter: 0, client: "a" } });
    expect(orderedLayerIds(d)).toEqual(["A", "C"]);
  });

  it("bring to front / send to back / move above", () => {
    let d = board();
    d = apply(d, setZ("A", zKeyTop(d, "A")));
    expect(orderedLayerIds(d)).toEqual(["B", "C", "A"]);
    d = apply(d, setZ("A", zKeyBottom(d, "A")));
    expect(orderedLayerIds(d)).toEqual(["A", "B", "C"]);
    d = apply(d, setZ("A", zKeyAbove(d, "B", "A")));
    expect(orderedLayerIds(d)).toEqual(["B", "A", "C"]);
  });

  it("concurrent inserts with the same key tie-break by id, and a later move still fits between", () => {
    const k = keyBetween(null, null);
    let d = applyAll(emptyDoc(), [create("X", k), create("Y", k), create("Z", keyBetween(k, null))]);
    expect(orderedLayerIds(d)).toEqual(["X", "Y", "Z"]);
    // Move Z directly above X; X and Y share a key, so it must land above both.
    d = apply(d, setZ("Z", zKeyAbove(d, "X", "Z")));
    const order = orderedLayerIds(d);
    expect(order.indexOf("Z")).toBeGreaterThan(order.indexOf("X"));
  });
});
