import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonical, readLayer, type Doc, type Json, type Op } from "../src/doc";
import { Replica } from "../src/replica";
import { orderedLayerIds } from "../src/zorder";

/** Fake time shared by all replicas in a test; every read advances it by 1 ms. */
function sharedTime() {
  let t = 1_000;
  return () => ++t;
}

function pair() {
  const now = sharedTime();
  const a = new Replica("a", { now });
  const b = new Replica("b", { now });
  // Fully connected, synchronous network: every op goes to the other side at once.
  const link = (from: Replica, to: Replica) => (ops: ReturnType<Replica["undo"]>) => {
    to.receive(ops);
    return ops;
  };
  return { a, b, toB: link(a, b), toA: link(b, a) };
}

const visible = (doc: Doc) =>
  Object.fromEntries(orderedLayerIds(doc).map((id) => [id, readLayer(doc, id)]));

describe("single-user undo/redo", () => {
  it("undoes and redoes a sequence of moves in order", () => {
    const r = new Replica("a", { now: sharedTime() });
    r.mutate((tx) => tx.create("s", { x: 0, fill: "red" }));
    r.mutate((tx) => tx.set("s", "x", 10));
    r.mutate((tx) => tx.set("s", "x", 20));

    r.undo();
    expect(r.doc.layers.get("s")!.fields.x!.v).toBe(10);
    r.undo();
    expect(r.doc.layers.get("s")!.fields.x!.v).toBe(0);
    r.undo();
    expect(readLayer(r.doc, "s")).toBeUndefined();
    expect(r.undo()).toEqual([]);

    r.redo();
    expect(readLayer(r.doc, "s")).toEqual({ x: 0, fill: "red" });
    r.redo();
    r.redo();
    expect(readLayer(r.doc, "s")!.x).toBe(20);
    expect(r.history.canRedo).toBe(false);
  });

  it("a new edit clears the redo stack", () => {
    const r = new Replica("a", { now: sharedTime() });
    r.mutate((tx) => tx.create("s", { x: 0 }));
    r.mutate((tx) => tx.set("s", "x", 1));
    r.undo();
    r.mutate((tx) => tx.set("s", "x", 5));
    expect(r.history.canRedo).toBe(false);
  });

  it("pause/resume groups a drag into one command whose undo restores the start", () => {
    const r = new Replica("a", { now: sharedTime() });
    r.mutate((tx) => tx.create("s", { x: 0, y: 0 }));
    r.history.pause();
    for (let i = 1; i <= 10; i++) r.mutate((tx) => tx.update("s", { x: i, y: i * 2 }));
    r.history.resume();
    r.undo();
    expect(readLayer(r.doc, "s")).toEqual({ x: 0, y: 0 });
    r.redo();
    expect(readLayer(r.doc, "s")).toEqual({ x: 10, y: 20 });
  });

  it("undoing a create-then-edit gesture just deletes the layer", () => {
    const r = new Replica("a", { now: sharedTime() });
    r.history.pause();
    r.mutate((tx) => tx.create("p", { x: 0 }));
    r.mutate((tx) => tx.set("p", "x", 5));
    r.history.resume();
    const ops = r.undo();
    expect(ops).toEqual([expect.objectContaining({ kind: "delete", layer: "p" })]);
    r.redo();
    expect(readLayer(r.doc, "p")).toEqual({ x: 5 });
  });

  it("undoing a delete restores the layer", () => {
    const r = new Replica("a", { now: sharedTime() });
    r.mutate((tx) => tx.create("s", { x: 3 }));
    r.mutate((tx) => tx.delete("s"));
    r.undo();
    expect(readLayer(r.doc, "s")).toEqual({ x: 3 });
  });

  it("a failing mutation leaves no trace", () => {
    const r = new Replica("a", { now: sharedTime() });
    r.mutate((tx) => tx.create("s", { x: 0 }));
    const before = r.doc;
    expect(() =>
      r.mutate((tx) => {
        tx.set("s", "x", 99);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(r.doc).toBe(before);
    r.undo();
    expect(readLayer(r.doc, "s")).toBeUndefined();
  });
});

describe("multiplayer undo", () => {
  it("undo reverts only my change, not a teammate's change to another field", () => {
    const { a, b, toA, toB } = pair();
    toB(a.mutate((tx) => tx.create("s", { x: 0, fill: "red" })));
    toB(a.mutate((tx) => tx.set("s", "x", 50)));
    toA(b.mutate((tx) => tx.set("s", "fill", "blue")));
    toB(a.undo());
    expect(readLayer(a.doc, "s")).toEqual({ x: 0, fill: "blue" });
    expect(canonical(a.doc)).toBe(canonical(b.doc));
  });

  it("undo skips a field a teammate changed after me", () => {
    const { a, b, toA, toB } = pair();
    toB(a.mutate((tx) => tx.create("s", { x: 0 })));
    toB(a.mutate((tx) => tx.set("s", "x", 50)));
    toA(b.mutate((tx) => tx.set("s", "x", 70)));
    // A's move was overwritten by B, so there is nothing of A's left to undo in that command.
    // The undo falls through to the create.
    const ops = toB(a.undo());
    expect(ops).toEqual([expect.objectContaining({ kind: "delete" })]);
    expect(a.doc.layers.get("s")!.fields.x!.v).toBe(70);
  });

  it("a teammate edit between two of my edits breaks the chain at that point", () => {
    const { a, b, toA, toB } = pair();
    toB(a.mutate((tx) => tx.create("s", { x: 0 })));
    toB(a.mutate((tx) => tx.set("s", "x", 10))); // cmd1
    toA(b.mutate((tx) => tx.set("s", "x", 20))); // teammate
    toB(a.mutate((tx) => tx.set("s", "x", 30))); // cmd2
    toB(a.undo()); // cmd2 -> back to teammate's 20
    expect(a.doc.layers.get("s")!.fields.x!.v).toBe(20);
    // cmd1's write was overwritten by B, so undo must not put x back to 0. It undoes the create.
    toB(a.undo());
    expect(a.doc.layers.get("s")!.fields.x!.v).toBe(20);
    expect(readLayer(a.doc, "s")).toBeUndefined();
    expect(canonical(a.doc)).toBe(canonical(b.doc));
  });

  it("redo skips a field a teammate changed after my undo", () => {
    const { a, b, toA, toB } = pair();
    toB(a.mutate((tx) => tx.create("s", { x: 0 })));
    toB(a.mutate((tx) => tx.set("s", "x", 10)));
    toB(a.undo());
    toA(b.mutate((tx) => tx.set("s", "x", 99)));
    expect(toB(a.redo())).toEqual([]);
    expect(a.doc.layers.get("s")!.fields.x!.v).toBe(99);
  });

  it("concurrent undo by two users converges", () => {
    const { a, b, toA, toB } = pair();
    toB(a.mutate((tx) => tx.create("s", { x: 0, y: 0 })));
    toB(a.mutate((tx) => tx.set("s", "x", 1)));
    toA(b.mutate((tx) => tx.set("s", "y", 1)));
    // Both undo at the same time; neither has seen the other's undo yet.
    const fromA = a.undo();
    const fromB = b.undo();
    a.receive(fromB);
    b.receive(fromA);
    expect(readLayer(a.doc, "s")).toEqual({ x: 0, y: 0 });
    expect(canonical(a.doc)).toBe(canonical(b.doc));
  });
});

describe("history properties", () => {
  type Step =
    | { t: "create"; id: number }
    | { t: "set"; id: number; field: "x" | "y" | "fill"; v: Json }
    | { t: "delete"; id: number }
    | { t: "gesture"; id: number; xs: number[] };

  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ t: fc.constant("create" as const), id: fc.nat(4) }),
    fc.record({
      t: fc.constant("set" as const),
      id: fc.nat(4),
      field: fc.constantFrom("x" as const, "y" as const, "fill" as const),
      v: fc.oneof(fc.integer({ min: -50, max: 50 }), fc.constantFrom("red", "blue")),
    }),
    fc.record({ t: fc.constant("delete" as const), id: fc.nat(4) }),
    fc.record({
      t: fc.constant("gesture" as const),
      id: fc.nat(4),
      xs: fc.array(fc.integer(), { minLength: 1, maxLength: 5 }),
    }),
  );

  function run(r: Replica, s: Step): Op[] {
    const out: Op[] = [];
    const mutate = (fn: Parameters<Replica["mutate"]>[0]) => out.push(...r.mutate(fn));
    const id = `l${s.id}`;
    const exists = readLayer(r.doc, id) !== undefined;
    const known = r.doc.layers.has(id);
    switch (s.t) {
      case "create":
        if (!known) mutate((tx) => tx.create(id, { x: 0, y: 0, fill: "red" }));
        break;
      case "set":
        if (exists) mutate((tx) => tx.set(id, s.field, s.v));
        break;
      case "delete":
        if (exists) mutate((tx) => tx.delete(id));
        break;
      case "gesture":
        if (!exists) break;
        r.history.pause();
        for (const x of s.xs) mutate((tx) => tx.set(id, "x", x));
        r.history.resume();
        break;
    }
    return out;
  }

  it("single user: undo everything gives the empty board, redo everything gives the final board", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        const r = new Replica("a", { now: sharedTime(), limit: 1_000 });
        for (const s of steps) run(r, s);
        const final = visible(r.doc);
        while (r.undo().length > 0);
        expect(visible(r.doc)).toEqual({});
        while (r.redo().length > 0);
        expect(visible(r.doc)).toEqual(final);
      }),
      { numRuns: 300 },
    );
  });

  it("two users: undo never touches a field whose newest write belongs to the other user", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), fc.oneof(step, fc.constant({ t: "undo" as const }))), {
          maxLength: 40,
        }),
        (script) => {
          const { a, b } = pair();
          for (const [isA, s] of script) {
            const me = isA ? a : b;
            const other = isA ? b : a;
            if (s.t === "undo") {
              const ops = me.undo();
              for (const op of ops) {
                const fieldName = op.kind === "set" ? op.field : "deleted";
                const owner = other.doc.layers.get(op.layer)?.fields[fieldName]?.ts.client;
                expect(owner).toBe(me.clientId);
              }
              other.receive(ops);
            } else {
              other.receive(run(me, s));
            }
          }
          expect(canonical(a.doc)).toBe(canonical(b.doc));
        },
      ),
      { numRuns: 300 },
    );
  });
});

