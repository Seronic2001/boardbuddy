import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Replica, type Doc } from "@boardbuddy/sync-core";
import { LayerType, type Layer } from "@/types/canvas";
import { recordToLayer, storageForTx, StorageViewCache } from "./layer-doc";
import type { MutableStorage } from "./types";

const rect = (x = 0): Layer => ({
  type: LayerType.Rectangle,
  x,
  y: 0,
  width: 100,
  height: 100,
  fill: { r: 1, g: 2, b: 3 },
});

function setup() {
  let t = 1_000;
  const replica = new Replica("user_a~tab", { now: () => ++t });
  const mutate = (fn: (s: MutableStorage) => void) => replica.mutate((tx) => fn(storageForTx(tx)));
  const order = () => new StorageViewCache().get(replica.doc).layerIds;
  return { replica, mutate, order };
}

/** What the canvas does to insert a layer (canvas.tsx insertLayer). */
const insert = (s: MutableStorage, id: string, layer = rect()) => {
  s.get("layerIds").push(id);
  s.get("layers").set(id, layer);
};

/** Same algorithms as selection-tools.tsx, so the façade must give LiveList results. */
function moveToFront(s: MutableStorage, selection: string[]) {
  const list = s.get("layerIds");
  const arr = list.toImmutable();
  const indices = arr.flatMap((id, i) => (selection.includes(id) ? [i] : []));
  for (let i = indices.length - 1; i >= 0; i--) list.move(indices[i]!, arr.length - 1 - (indices.length - 1 - i));
}
function moveToBack(s: MutableStorage, selection: string[]) {
  const list = s.get("layerIds");
  const indices = list.toImmutable().flatMap((id, i) => (selection.includes(id) ? [i] : []));
  for (let i = 0; i < indices.length; i++) list.move(indices[i]!, i);
}

describe("storageForTx (Liveblocks-shaped API over BuddySync)", () => {
  it("inserts, reads, updates and deletes layers", () => {
    const { replica, mutate, order } = setup();
    mutate((s) => insert(s, "a", rect(5)));
    mutate((s) => insert(s, "b"));
    expect(order()).toEqual(["a", "b"]);

    mutate((s) => {
      const layer = s.get("layers").get("a")!;
      expect(layer.get("x")).toBe(5);
      layer.update({ x: 50, y: 7 });
      layer.set("fill", { r: 9, g: 9, b: 9 });
    });
    const view = new StorageViewCache().get(replica.doc);
    expect(view.layers.get("a")).toEqual({ ...rect(50), y: 7, fill: { r: 9, g: 9, b: 9 } });
    expect(view.layers.get("a")).not.toHaveProperty("z");

    mutate((s) => {
      s.get("layers").delete("a");
      s.get("layerIds").delete(s.get("layerIds").indexOf("a"));
    });
    expect(order()).toEqual(["b"]);
    expect(mutate((s) => expect(s.get("layers").size).toBe(1))).toBeDefined();
  });

  it("bring to front / send to back with a multi-selection match LiveList behaviour", () => {
    const { mutate, order } = setup();
    for (const id of ["a", "b", "c", "d", "e"]) mutate((s) => insert(s, id));
    mutate((s) => moveToFront(s, ["b", "d"]));
    expect(order()).toEqual(["a", "c", "e", "b", "d"]);
    mutate((s) => moveToBack(s, ["e", "d"]));
    expect(order()).toEqual(["e", "d", "a", "c", "b"]);
  });

  it("property: random inserts, moves and deletes give the same order as a plain array", () => {
    const op = fc.oneof(
      fc.constant({ kind: "insert" as const }),
      fc.record({ kind: fc.constant("move" as const), from: fc.nat(30), to: fc.nat(30) }),
      fc.record({ kind: fc.constant("delete" as const), at: fc.nat(30) }),
      fc.record({ kind: fc.constant("front" as const), picks: fc.array(fc.nat(30), { maxLength: 4 }) }),
      fc.record({ kind: fc.constant("back" as const), picks: fc.array(fc.nat(30), { maxLength: 4 }) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), (ops) => {
        const { mutate, order } = setup();
        const ref: string[] = [];
        let next = 0;
        for (const o of ops) {
          if (o.kind === "insert") {
            const id = `l${next++}`;
            mutate((s) => insert(s, id));
            ref.push(id);
          } else if (o.kind === "move" && ref.length > 0) {
            const from = o.from % ref.length;
            const to = o.to % ref.length;
            mutate((s) => s.get("layerIds").move(from, to));
            ref.splice(to, 0, ref.splice(from, 1)[0]!);
          } else if (o.kind === "delete" && ref.length > 0) {
            const id = ref[o.at % ref.length]!;
            mutate((s) => s.get("layers").delete(id));
            ref.splice(ref.indexOf(id), 1);
          } else if ((o.kind === "front" || o.kind === "back") && ref.length > 0) {
            const selection = [...new Set(o.picks.map((p) => ref[p % ref.length]!))];
            mutate((s) => (o.kind === "front" ? moveToFront : moveToBack)(s, selection));
            const picked = ref.filter((id) => selection.includes(id));
            const rest = ref.filter((id) => !selection.includes(id));
            ref.splice(0, ref.length, ...(o.kind === "front" ? [...rest, ...picked] : [...picked, ...rest]));
          }
          expect(order()).toEqual(ref);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("a whole canvas action is one undo step", () => {
    const { replica, mutate, order } = setup();
    mutate((s) => insert(s, "a"));
    mutate((s) => insert(s, "b"));
    mutate((s) => moveToBack(s, ["b"]));
    expect(order()).toEqual(["b", "a"]);
    replica.undo();
    expect(order()).toEqual(["a", "b"]);
  });
});

describe("StorageViewCache", () => {
  it("keeps identity for unchanged layers and for an unchanged order", () => {
    const { replica, mutate } = setup();
    mutate((s) => insert(s, "a"));
    mutate((s) => insert(s, "b"));
    const cache = new StorageViewCache();
    const v1 = cache.get(replica.doc);
    expect(cache.get(replica.doc)).toBe(v1);
    mutate((s) => s.get("layers").get("b")!.set("x", 99));
    const v2 = cache.get(replica.doc);
    expect(v2).not.toBe(v1);
    expect(v2.layers.get("a")).toBe(v1.layers.get("a"));
    expect(v2.layers.get("b")).not.toBe(v1.layers.get("b"));
    expect(v2.layerIds).toBe(v1.layerIds);
  });
});

describe("recordToLayer", () => {
  it("coerces junk written by a misbehaving client into a renderable layer", () => {
    const record: Doc["layers"] extends ReadonlyMap<string, infer R> ? R : never = {
      id: "x",
      fields: Object.fromEntries(
        Object.entries({ type: LayerType.Path, x: "evil", fill: [1, 2], points: [[1, 2, 0.5], "nope", [3]] }).map(
          ([k, v]) => [k, { v, ts: { wall: 1, counter: 0, client: "c" } }],
        ),
      ),
    };
    expect(recordToLayer(record)).toEqual({
      type: LayerType.Path,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fill: { r: 0, g: 0, b: 0 },
      points: [[1, 2, 0.5]],
    });
  });
});
