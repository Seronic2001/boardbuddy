/**
 * Load test for the sync server: R rooms × C clients, each sending cursor presence at
 * 30 Hz and an edit at 2 Hz through the real SyncClient. Measures, inside a fixed window
 * after a warm-up:
 *
 *   cursor latency   presence sent → received by each other client in the room
 *   edit latency     edit sent → op received by each other client (includes group commit)
 *   ack latency      edit sent → the sender's ack (the edit is durable)
 *
 * plus throughput, bandwidth per client, and the server's CPU and memory (from /healthz).
 *
 *   npm run bench:load -w @boardbuddy/sync-server -- --rooms 50 --clients 5 --duration 30
 *
 * Needs SYNC_PRIVATE_KEY matching the server's SYNC_PUBLIC_KEY (read from the repo's
 * .env.local). Latencies are only trustworthy while the generator keeps up: watch the
 * "busiest thread" figure, and add --workers if it nears saturation.
 */
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { writeFile } from "node:fs/promises";
import { Histogram } from "./histogram";
import type { FromWorker, WorkerConfig, WorkerCounters } from "./load-worker";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "ws://localhost:8787" },
    origin: { type: "string", default: "http://localhost:3000" },
    rooms: { type: "string", default: "10" },
    clients: { type: "string", default: "5" },
    "cursor-hz": { type: "string", default: "30" },
    "edit-hz": { type: "string", default: "2" },
    duration: { type: "string", default: "30" },
    warmup: { type: "string", default: "5" },
    ramp: { type: "string", default: "5" },
    workers: { type: "string", default: String(Math.max(1, Math.min(4, availableParallelism() - 2))) },
    "legacy-presence": { type: "boolean", default: false },
    json: { type: "string" },
    label: { type: "string" },
  },
});

const rooms = Number(args.rooms);
const clientsPerRoom = Number(args.clients);
const durationSec = Number(args.duration);
const warmupSec = Number(args.warmup);
const workerCount = Math.max(1, Math.min(Number(args.workers), rooms));
const httpUrl = args.url!.replace(/^ws/, "http").replace(/\/$/, "") + "/healthz";

const privateKeyPem = process.env.SYNC_PRIVATE_KEY ?? "";
if (!privateKeyPem) {
  console.error("SYNC_PRIVATE_KEY is not set (it must match the server's SYNC_PUBLIC_KEY).");
  process.exit(1);
}

type Health = { rooms: number; connections: number; rss: number; heapUsed: number; cpuMicros: number };
async function health(): Promise<Health> {
  const res = await fetch(httpUrl);
  if (!res.ok) throw new Error(`${httpUrl}: ${res.status}`);
  return (await res.json()) as Health;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const before = await health();
  const run = Date.now().toString(36);
  const boardIds = Array.from({ length: rooms }, (_, i) => `bench-${run}-${i}`);

  console.log(
    `${rooms} rooms × ${clientsPerRoom} clients = ${rooms * clientsPerRoom} connections; ` +
      `cursors ${args["cursor-hz"]} Hz, edits ${args["edit-hz"]} Hz; ${workerCount} generator thread(s)`,
  );

  const workers = Array.from({ length: workerCount }, (_, w) => {
    const config: WorkerConfig = {
      url: args.url!,
      origin: args.origin!,
      rooms: boardIds.filter((_, i) => i % workerCount === w),
      clientsPerRoom,
      cursorHz: Number(args["cursor-hz"]),
      editHz: Number(args["edit-hz"]),
      privateKeyPem,
      legacyPresence: args["legacy-presence"]!,
      rampMs: Number(args.ramp) * 1000,
    };
    return new Worker(fileURLToPath(new URL("./load-worker.ts", import.meta.url)), { workerData: config });
  });
  const next = (w: Worker) =>
    new Promise<FromWorker>((resolve, reject) => {
      w.once("message", resolve);
      w.once("error", reject);
    });

  const ready = await Promise.all(workers.map(next));
  const connected = ready.reduce((n, r) => n + (r.t === "ready" ? r.connected : 0), 0);
  const failed = ready.reduce((n, r) => n + (r.t === "ready" ? r.failed : 0), 0);
  console.log(`connected ${connected}${failed ? `, ${failed} FAILED` : ""}; warming up ${warmupSec} s`);
  await sleep(warmupSec * 1000);

  for (const w of workers) w.postMessage({ t: "start-measuring" });
  const start = await health();
  const startedAt = Date.now();
  const samples: Health[] = [];
  while (Date.now() - startedAt < durationSec * 1000) {
    await sleep(1000);
    samples.push(await health());
  }
  const end = samples.at(-1)!;
  const elapsedSec = (Date.now() - startedAt) / 1000;
  const results = workers.map(next);
  for (const w of workers) w.postMessage({ t: "stop" });
  const finished = (await Promise.all(results)).filter((r) => r.t === "result");
  await Promise.all(workers.map((w) => w.terminate()));

  const cursor = new Histogram();
  const edit = new Histogram();
  const ack = new Histogram();
  const totals: WorkerCounters = {
    connected: 0, failedConnects: 0, unexpectedCloses: 0, serverErrors: 0, presenceSent: 0,
    editsSent: 0, messagesReceived: 0, bytesSent: 0, bytesReceived: 0,
  };
  let busiest = 0;
  for (const r of finished) {
    cursor.merge(r.cursor);
    edit.merge(r.edit);
    ack.merge(r.ack);
    for (const k of Object.keys(totals) as (keyof WorkerCounters)[]) totals[k] += r.counters[k];
    busiest = Math.max(busiest, r.utilization);
  }

  const serverCpu = (end.cpuMicros - start.cpuMicros) / 1e6 / elapsedSec;
  const peakRss = Math.max(...samples.map((s) => s.rss));
  const peakHeap = Math.max(...samples.map((s) => s.heapUsed));
  const perClient = (n: number) => n / elapsedSec / Math.max(1, connected);
  const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
  const fmt = (h: Histogram) =>
    h.n === 0
      ? "no samples"
      : `p50 ${h.percentile(50).toFixed(1)}  p95 ${h.percentile(95).toFixed(1)}  p99 ${h.percentile(99).toFixed(1)}  ` +
        `max ${h.max.toFixed(1)} ms  (${h.n.toLocaleString()} samples)`;

  console.log(`\nmeasured ${elapsedSec.toFixed(1)} s`);
  console.log(`cursor latency   ${fmt(cursor)}`);
  console.log(`edit latency     ${fmt(edit)}`);
  console.log(`ack latency      ${fmt(ack)}`);
  console.log(
    `throughput       ${Math.round(totals.messagesReceived / elapsedSec).toLocaleString()} msgs/s delivered, ` +
      `${Math.round(totals.presenceSent / elapsedSec).toLocaleString()} cursors/s and ` +
      `${Math.round(totals.editsSent / elapsedSec).toLocaleString()} edits/s sent`,
  );
  console.log(
    `bandwidth        per client ${(perClient(totals.bytesReceived) / 1024).toFixed(1)} KB/s down, ` +
      `${(perClient(totals.bytesSent) / 1024).toFixed(1)} KB/s up`,
  );
  console.log(
    `server           CPU ${(serverCpu * 100).toFixed(0)}% of one core; RSS ${mb(before.rss)} → peak ${mb(peakRss)} MB, ` +
      `heap ${mb(before.heapUsed)} → peak ${mb(peakHeap)} MB; ${end.rooms} rooms, ${end.connections} connections`,
  );
  console.log(`generator        busiest thread ${(busiest * 100).toFixed(0)}% busy`);
  const problems = [
    failed && `${failed} failed connects`,
    totals.unexpectedCloses && `${totals.unexpectedCloses} unexpected closes`,
    totals.serverErrors && `${totals.serverErrors} server errors`,
  ].filter(Boolean);
  if (problems.length) console.log(`PROBLEMS         ${problems.join(", ")}`);
  if (busiest > 0.6) console.log("WARNING          the generator is near saturation; latencies include its own delay (add --workers)");

  if (args.json) {
    const summary = (h: Histogram) => ({
      p50: h.percentile(50), p95: h.percentile(95), p99: h.percentile(99), max: h.max, mean: h.mean, n: h.n,
    });
    await writeFile(
      args.json,
      JSON.stringify(
        {
          label: args.label ?? null,
          at: new Date().toISOString(),
          config: { legacyPresence: args["legacy-presence"], rooms, clientsPerRoom, cursorHz: Number(args["cursor-hz"]), editHz: Number(args["edit-hz"]), durationSec, workers: workerCount },
          connected, failed,
          latencyMs: { cursor: summary(cursor), edit: summary(edit), ack: summary(ack) },
          perSecond: { delivered: totals.messagesReceived / elapsedSec, cursors: totals.presenceSent / elapsedSec, edits: totals.editsSent / elapsedSec },
          bytesPerClientPerSecond: { down: perClient(totals.bytesReceived), up: perClient(totals.bytesSent) },
          server: { cpuCores: serverCpu, rssBefore: before.rss, rssPeak: peakRss, heapBefore: before.heapUsed, heapPeak: peakHeap },
          generator: { busiestThreadUtilization: busiest },
          problems: { unexpectedCloses: totals.unexpectedCloses, serverErrors: totals.serverErrors },
        },
        null,
        2,
      ),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
