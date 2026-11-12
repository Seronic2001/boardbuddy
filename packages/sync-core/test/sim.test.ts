import { describe, expect, it } from "vitest";
import { runSimulation, type SimConfig } from "../sim/simulator";
import regressions from "./regression-seeds.json";

describe("network simulator", () => {
  it("converges on 25 seeds with drops, duplicates, reordering, offline clients and server crashes", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 25; seed++) {
      const result = runSimulation({ seed, clients: 5, ops: 1_500, crash: 0.01 });
      if (!result.ok) failures.push(`seed ${seed}: ${result.error}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);

  it("survives a hostile network (40% drops, 50% reordering)", () => {
    const result = runSimulation({ seed: 7, clients: 6, ops: 2_000, drop: 0.4, reorder: 0.5 });
    expect(result.ok ? "converged" : result.error).toBe("converged");
  }, 60_000);

  it("is deterministic: the same seed gives the same run", () => {
    const a = runSimulation({ seed: 99, ops: 1_000 });
    const b = runSimulation({ seed: 99, ops: 1_000 });
    expect(a.stats).toEqual(b.stats);
  });

  const saved = regressions as SimConfig[];
  it.skipIf(saved.length === 0).each(saved.map((cfg) => [cfg.seed, cfg] as const))(
    "regression seed %i still converges",
    (_seed, cfg) => {
      const result = runSimulation(cfg);
      expect(result.ok ? "converged" : result.error).toBe("converged");
    },
    120_000,
  );
});
