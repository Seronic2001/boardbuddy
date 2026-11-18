import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultConfig, runSimulation, type SimConfig } from "./simulator";

/**
 * npm run sim -- --seed 42 --clients 8 --ops 50000 --drop 0.2 --reorder 0.3
 * npm run sim -- --seeds 1000            (seeds 1..1000, or from --seed)
 * npm run sim -- --tombstone-ttl 2000    (purge deleted layers after 2 s of sim time)
 *
 * Failing configs are appended to test/regression-seeds.json, which the test suite replays.
 */

const { values } = parseArgs({
  options: {
    seed: { type: "string" },
    seeds: { type: "string" },
    clients: { type: "string" },
    ops: { type: "string" },
    drop: { type: "string" },
    duplicate: { type: "string" },
    reorder: { type: "string" },
    offline: { type: "string" },
    crash: { type: "string" },
    "tombstone-ttl": { type: "string" },
    "no-save": { type: "boolean" },
  },
});

const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v));
const base: Omit<SimConfig, "seed"> = {
  ...defaultConfig,
  clients: num(values.clients, defaultConfig.clients),
  ops: num(values.ops, defaultConfig.ops),
  drop: num(values.drop, defaultConfig.drop),
  duplicate: num(values.duplicate, defaultConfig.duplicate),
  reorder: num(values.reorder, defaultConfig.reorder),
  offline: num(values.offline, defaultConfig.offline),
  crash: num(values.crash, defaultConfig.crash),
  tombstoneTtlMs: num(values["tombstone-ttl"], defaultConfig.tombstoneTtlMs),
};
const first = num(values.seed, 1);
const count = num(values.seeds, 1);

const regressionFile = fileURLToPath(new URL("../test/regression-seeds.json", import.meta.url));
const started = Date.now();
const totals = { ops: 0, crashes: 0, dropped: 0, snapshotCatchups: 0, offline: 0, purged: 0, gone: 0 };
const failures: number[] = [];

for (let seed = first; seed < first + count; seed++) {
  const t0 = Date.now();
  const result = runSimulation({ ...base, seed });
  const s = result.stats;
  totals.ops += s.opsGenerated;
  totals.crashes += s.crashes;
  totals.dropped += s.dropped;
  totals.snapshotCatchups += s.snapshotCatchups;
  totals.offline += s.offlinePeriods;
  totals.purged += s.purged;
  totals.gone += s.goneRejections;

  if (result.ok) {
    if (count === 1) {
      console.log(
        `seed ${seed}: converged in ${Date.now() - t0} ms ` +
          `(${s.opsGenerated} ops, ${s.messages} msgs, ${s.dropped} dropped, ${s.duplicated} duplicated, ` +
          `${s.crashes} server crashes, ${s.offlinePeriods} offline periods, ` +
          `${s.snapshotCatchups} snapshot catch-ups, ${s.undos} undos, ${s.purged} tombstones purged, ` +
          `${s.goneRejections} late ops on purged layers, ${(s.simTimeMs / 1000).toFixed(0)} s simulated)`,
      );
    } else if ((seed - first + 1) % 50 === 0) {
      console.log(`  ${seed - first + 1}/${count} seeds done`);
    }
  } else {
    failures.push(seed);
    console.error(`seed ${seed}: FAILED at t=${result.atMs} ms: ${result.error}`);
    if (!values["no-save"]) saveRegression({ ...base, seed });
  }
}

if (count > 1) {
  console.log(
    `${count - failures.length}/${count} seeds converged in ${((Date.now() - started) / 1000).toFixed(1)} s ` +
      `(${totals.ops} ops, ${totals.crashes} server crashes, ${totals.offline} offline periods, ` +
      `${totals.dropped} dropped msgs, ${totals.snapshotCatchups} snapshot catch-ups, ` +
      `${totals.purged} tombstones purged, ${totals.gone} late ops on purged layers)`,
  );
}
if (failures.length > 0) {
  console.error(`failing seeds: ${failures.join(", ")}`);
  process.exit(1);
}

function saveRegression(cfg: SimConfig): void {
  let list: SimConfig[] = [];
  try {
    list = JSON.parse(readFileSync(regressionFile, "utf8")) as SimConfig[];
  } catch {
    // first failure: start a new file
  }
  if (!list.some((c) => JSON.stringify(c) === JSON.stringify(cfg))) {
    list.push(cfg);
    writeFileSync(regressionFile, JSON.stringify(list, null, 2) + "\n");
  }
}
