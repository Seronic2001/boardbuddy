import fc from "fast-check";
import type { Json, Op } from "../src/doc";

const LAYERS = ["l1", "l2", "l3"];
const FIELDS = ["x", "y", "fill", "z"];
const CLIENTS = ["a", "b", "c"];

const value: fc.Arbitrary<Json> = fc.oneof(
  fc.integer({ min: -100, max: 100 }),
  fc.constantFrom("red", "blue"),
  fc.record({ r: fc.nat(255), g: fc.nat(255), b: fc.nat(255) }),
);

type Draft =
  | { kind: "create"; layer: string; fields: Record<string, Json> }
  | { kind: "set"; layer: string; field: string; v: Json }
  | { kind: "delete"; layer: string }
  | { kind: "restore"; layer: string };

const draft: fc.Arbitrary<Draft> = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("create" as const),
      layer: fc.constantFrom(...LAYERS),
      fields: fc.dictionary(fc.constantFrom(...FIELDS), value),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("set" as const),
      layer: fc.constantFrom(...LAYERS),
      field: fc.constantFrom(...FIELDS),
      v: value,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("delete" as const), layer: fc.constantFrom(...LAYERS) }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant("restore" as const), layer: fc.constantFrom(...LAYERS) }),
  },
);

/**
 * Ops with unique timestamps. A tiny wall range forces many same-millisecond ties, so the
 * counter and client tie-breakers get exercised. The counter is the op index, which keeps
 * every timestamp unique (real clients guarantee this with Clock.tick()).
 */
export const ops = (maxLength = 40): fc.Arbitrary<Op[]> =>
  fc
    .array(fc.tuple(draft, fc.integer({ min: 0, max: 3 }), fc.constantFrom(...CLIENTS)), {
      maxLength,
    })
    .map((items) =>
      items.map(([d, wall, client], counter) => ({ ...d, ts: { wall, counter, client } }) as Op),
    );

/** The same ops in a random order with random duplicates inserted. */
export const reorderedWithDuplicates = (list: Op[]): fc.Arbitrary<Op[]> =>
  fc
    .tuple(
      fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length }),
      fc.array(fc.nat(Math.max(0, list.length - 1)), { maxLength: list.length }),
      fc.array(fc.nat(), { maxLength: list.length }),
    )
    .map(([shuffled, dupIdx, positions]) => {
      const out = [...shuffled];
      if (list.length === 0) return out;
      dupIdx.forEach((i, k) => out.splice((positions[k] ?? 0) % (out.length + 1), 0, list[i]!));
      return out;
    });
