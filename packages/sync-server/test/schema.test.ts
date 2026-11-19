import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isPresenceData, parseClientMessage, presenceData } from "../src/schema";

const zodSays = (v: unknown) => presenceData.safeParse(v).success;

/** Nests `inner` inside `levels` arrays: depth counts from the presence value at 1. */
const nest = (levels: number, inner: unknown = 1): unknown => (levels === 0 ? inner : [nest(levels - 1, inner)]);

describe("presence validation fast path", () => {
  const cases: [string, unknown][] = [
    ["a cursor", { cursor: { x: 1.5, y: -2 } }],
    ["null values", { cursor: null, selection: [] }],
    ["not an object", [1, 2]],
    ["null", null],
    ["a string", "x"],
    ["16 keys", Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, i]))],
    ["17 keys", Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i]))],
    ["a 32-char key", { ["k".repeat(32)]: 1 }],
    ["a 33-char key", { ["k".repeat(33)]: 1 }],
    ["Infinity (JSON.parse gives it for 1e400)", { x: JSON.parse("1e400") }],
    ["a 10,000-char string", { s: "a".repeat(10_000) }],
    ["a 10,001-char string", { s: "a".repeat(10_001) }],
    ["a 5,000-item array", { a: new Array(5_000).fill(0) }],
    ["a 5,001-item array", { a: new Array(5_001).fill(0) }],
    ["nested 64 keys", { o: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, i])) }],
    ["nested 65 keys", { o: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])) }],
    ["a nested 64-char key", { o: { ["k".repeat(64)]: 1 } }],
    ["a nested 65-char key", { o: { ["k".repeat(65)]: 1 } }],
    ["scalars at the depth limit", { d: nest(5) }],
    ["an empty array at the depth limit", { d: nest(5, []) }],
    ["one level too deep", { d: nest(6) }],
    ["an empty object at the depth limit", { d: nest(5, {}) }],
  ];

  it.each(cases)("agrees with the zod schema: %s", (_, value) => {
    expect(isPresenceData(value)).toBe(zodSays(value));
  });

  it("agrees with the zod schema on random JSON", () => {
    const value = fc.oneof(
      fc.jsonValue({ maxDepth: 8 }),
      fc.dictionary(fc.string({ maxLength: 40 }), fc.jsonValue({ maxDepth: 8 }), { maxKeys: 20 }),
    );
    fc.assert(
      fc.property(value, (v) => isPresenceData(v) === zodSays(v)),
      { numRuns: 3_000 },
    );
  });

  it("parses a presence message and drops unknown top-level fields, like the zod schema did", () => {
    expect(parseClientMessage(JSON.stringify({ t: "presence", data: { cursor: { x: 1, y: 2 } }, extra: 1 }))).toEqual({
      t: "presence",
      data: { cursor: { x: 1, y: 2 } },
    });
    expect(parseClientMessage(JSON.stringify({ t: "presence", data: [1] }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ t: "presence" }))).toBeNull();
  });
});
