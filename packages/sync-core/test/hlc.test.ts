import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Clock, ClockDriftError, compareHLC, decodeHLC, encodeHLC, type HLC } from "../src/hlc";

function fakeTime(start = 1_000) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

describe("Clock", () => {
  it("tick is strictly increasing even when physical time stands still", () => {
    const time = fakeTime();
    const c = new Clock("a", { now: time.now });
    const a = c.tick();
    const b = c.tick();
    expect(compareHLC(a, b)).toBe(-1);
    expect(b).toEqual({ wall: 1_000, counter: 1, client: "a" });
  });

  it("tick is strictly increasing when physical time goes backwards", () => {
    const time = fakeTime(5_000);
    const c = new Clock("a", { now: time.now });
    const a = c.tick();
    time.set(4_000);
    const b = c.tick();
    expect(compareHLC(a, b)).toBe(-1);
    expect(b.wall).toBe(5_000);
  });

  it("resets the counter when physical time advances", () => {
    const time = fakeTime();
    const c = new Clock("a", { now: time.now });
    c.tick();
    c.tick();
    time.set(2_000);
    expect(c.tick()).toEqual({ wall: 2_000, counter: 0, client: "a" });
  });

  it("after receive, local ticks sort after the remote timestamp (slow local clock)", () => {
    const time = fakeTime(1_000);
    const c = new Clock("a", { now: time.now });
    const remote: HLC = { wall: 1_500, counter: 7, client: "b" };
    c.receive(remote);
    expect(compareHLC(c.tick(), remote)).toBe(1);
  });

  it("rejects remote timestamps beyond the allowed drift", () => {
    const time = fakeTime(1_000);
    const c = new Clock("a", { now: time.now, maxDriftMs: 100 });
    expect(() => c.receive({ wall: 1_101, counter: 0, client: "b" })).toThrow(ClockDriftError);
    // The clock is unchanged after a rejection.
    expect(c.tick()).toEqual({ wall: 1_000, counter: 0, client: "a" });
  });

  it("property: any interleaving of ticks and receives keeps the clock monotonic and causal", () => {
    const event = fc.oneof(
      fc.record({ type: fc.constant("tick" as const), dt: fc.integer({ min: -50, max: 50 }) }),
      fc.record({
        type: fc.constant("recv" as const),
        dt: fc.integer({ min: -50, max: 50 }),
        wall: fc.integer({ min: 0, max: 2_000 }),
        counter: fc.integer({ min: 0, max: 20 }),
      }),
    );
    fc.assert(
      fc.property(fc.array(event, { maxLength: 200 }), (events) => {
        const time = fakeTime(1_000);
        const c = new Clock("a", { now: time.now, maxDriftMs: 10_000 });
        let last = c.current();
        let maxSeen: HLC | null = null;
        let t = 1_000;
        for (const e of events) {
          t += e.dt;
          time.set(t);
          let next: HLC;
          if (e.type === "tick") {
            next = c.tick();
          } else {
            const remote = { wall: e.wall, counter: e.counter, client: "b" };
            next = c.receive(remote);
            expect(compareHLC(next, remote)).toBe(1);
            if (!maxSeen || compareHLC(remote, maxSeen) > 0) maxSeen = remote;
          }
          expect(compareHLC(next, last)).toBe(1);
          if (maxSeen) expect(compareHLC(next, maxSeen)).toBe(1);
          last = next;
        }
      }),
    );
  });
});

describe("encodeHLC", () => {
  const hlc = fc.record({
    wall: fc.integer({ min: 0, max: 2 ** 47 }),
    counter: fc.integer({ min: 0, max: 36 ** 5 - 1 }),
    client: fc.stringMatching(/^[a-z0-9_-]{1,12}$/),
  });

  it("round-trips", () => {
    fc.assert(fc.property(hlc, (ts) => {
        expect(decodeHLC(encodeHLC(ts))).toEqual(ts);
      }),
    );
  });

  it("string order matches compareHLC", () => {
    fc.assert(
      fc.property(hlc, hlc, (a, b) => {
        const s = Math.sign(encodeHLC(a) < encodeHLC(b) ? -1 : encodeHLC(a) > encodeHLC(b) ? 1 : 0);
        expect(s).toBe(compareHLC(a, b));
      }),
    );
  });
});
