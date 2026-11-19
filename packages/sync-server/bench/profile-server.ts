/**
 * Runs a memory-backed sync server under the V8 CPU profiler, then prints the functions
 * with the most self time. Point the load test at it while it runs:
 *
 *   npm run bench:profile -w @boardbuddy/sync-server -- --seconds 40 --port 8789
 *   npm run bench:load -w @boardbuddy/sync-server -- --url ws://localhost:8789 --duration 20
 *
 * The full profile is written to bench/results/server.cpuprofile (open it in Chrome
 * DevTools or speedscope).
 */
import { Session } from "node:inspector/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadPublicKey } from "../src/auth";
import { MemoryPersister } from "../src/persister";
import { startSyncServer } from "../src/server";

const { values: args } = parseArgs({
  options: {
    seconds: { type: "string", default: "40" },
    port: { type: "string", default: "8789" },
    top: { type: "string", default: "25" },
    out: { type: "string", default: fileURLToPath(new URL("../../../bench/results/server.cpuprofile", import.meta.url)) },
  },
});

type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number };
type Profile = { nodes: Node[]; samples: number[]; timeDeltas: number[] };

const pem = process.env.SYNC_PUBLIC_KEY;
if (!pem) throw new Error("SYNC_PUBLIC_KEY is not set");

const server = await startSyncServer({
  port: Number(args.port),
  publicKey: await loadPublicKey(pem),
  persister: new MemoryPersister(),
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()),
});
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.setSamplingInterval", { interval: 200 });
await session.post("Profiler.start");
console.log(`profiling a memory-backed server on port ${server.port} for ${args.seconds} s`);

await new Promise((r) => setTimeout(r, Number(args.seconds) * 1000));
const { profile } = (await session.post("Profiler.stop")) as unknown as { profile: Profile };
await mkdir(dirname(args.out!), { recursive: true });
await writeFile(args.out!, JSON.stringify(profile));

// Self time per function: each sample's delta goes to the node that was on top.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map<string, number>();
let total = 0;
profile.samples.forEach((id, i) => {
  const dt = profile.timeDeltas[i] ?? 0;
  const frame = byId.get(id)!.callFrame;
  const where = frame.url ? `${frame.url.replace(/^.*node_modules[\\/]/, "").replace(/^file:\/\/\/.*boardbuddy[\\/]/, "")}:${frame.lineNumber + 1}` : "";
  const name = `${frame.functionName || "(anonymous)"} ${where}`.trim();
  self.set(name, (self.get(name) ?? 0) + dt);
  total += dt;
});
const idle = (self.get("(idle)") ?? 0) / total;
console.log(`\nbusy ${((1 - idle) * 100).toFixed(0)}% of ${(total / 1e6).toFixed(1)} s; top self time (share of busy time):`);
[...self.entries()]
  .filter(([name]) => name !== "(idle)")
  .sort((a, b) => b[1] - a[1])
  .slice(0, Number(args.top))
  .forEach(([name, us]) => console.log(`${((us / (total * (1 - idle))) * 100).toFixed(1).padStart(5)}%  ${name}`));
console.log(`\nfull profile: ${args.out}`);

await server.close();
process.exit(0);
