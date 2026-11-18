# BuddySync benchmark results

## How to run

```sh
# terminal 1: a sync server (production bundle), here on local Postgres
npm run build -w @boardbuddy/sync-server
cd packages/sync-server && DATABASE_URL=postgres://buddysync:buddysync@localhost:5433/buddysync node dist/main.mjs

# terminal 2: the load test
npm run bench:load -w @boardbuddy/sync-server -- --rooms 50 --clients 5 --duration 30 --json bench/results/x.json

# CPU profile of a memory-backed server under the same load
npm run bench:profile -w @boardbuddy/sync-server -- --seconds 45
npm run bench:load -w @boardbuddy/sync-server -- --url ws://localhost:8789 --rooms 50 --clients 5 --duration 20
```

The load test (`packages/sync-server/bench/load.ts`) runs R rooms × C clients. Each client
uses the real `SyncClient`, sends cursor presence at 30 Hz and edits one field of its own
layer at 2 Hz. Every message carries its send time, and all clients of a room run in the
same generator thread, so sender and receiver share a clock.

| Metric | Meaning |
|---|---|
| cursor latency | presence sent → received by each other client in the room |
| edit latency | edit sent → op received by each other client (includes group commit) |
| ack latency | edit sent → the sender's ack, i.e. the edit is durable |

Server CPU and memory come from `/healthz` (CPU time and RSS of the server process).

## Setup

- Laptop: AMD Ryzen 5 3550H (4 cores / 8 threads), 14 GB, Windows 11, Node 24.
- Server, generator (4 worker threads) and Postgres 17 (Docker Desktop, WSL2) all on the
  same machine, so they compete for CPU. Absolute numbers are pessimistic; the shape of the
  curves and the bottlenecks are the useful part.
- One sync server process (single-threaded Node), defaults: group commit every 50 ms,
  presence throttled to one broadcast per user per 33 ms.
- 30 s measured window after a 5 s warm-up.

## Baseline (2026-11-18)

Raw output in `results/baseline/`. In runs marked *, latencies passed the histogram's old
2 s ceiling, so only the max is reliable there (the histogram has since been extended).

### Many small rooms (5 clients each), Postgres

| Rooms × clients | Connections | Cursor p50 / p99 | Edit p50 / p99 | Server CPU | Server RSS peak |
|---|---|---|---|---|---|
| 10 × 5 | 50 | 21 / 50 ms | 47 / 122 ms | 40% | 126 MB |
| 50 × 5 | 250 | 99 / 432 ms | *> 2 s, max 9.8 s* | 89% | 170 MB |
| 100 × 5 | 500 | 283 / 2,753 ms | *> 2 s, max 35.9 s* | 86% | 231 MB |
| 200 × 5 | 1,000 | 592 / 3,571 ms | none delivered in window | 97% | 266 MB |
| 400 × 5 | 2,000 | aborted: `/healthz` reset under load (server stayed up) | | | |

Same 50 × 5 load on a memory-only server: cursor 63 / 477 ms, edit 99 / 733 ms, CPU 94%.

### One big room, Postgres

| Clients | Cursor p50 / p99 | Edit p50 / p99 | Delivered msgs/s | Down per client | Server CPU |
|---|---|---|---|---|---|
| 10 | 20 / 49 ms | 49 / 119 ms | 2,309 | 35 KB/s | 19% |
| 25 | 24 / 54 ms | 53 / 159 ms | 14,821 | 93 KB/s | 54% |
| 50 | 47 / 163 ms | 382 / 943 ms | 33,699 | 116 KB/s | 99% (generator also near saturation) |

### What the numbers say

1. **Persistence is the first wall.** Every room commits its own transaction every 50 ms
   (begin, insert ops, upsert cseqs, commit). This setup manages about 820 trivial
   four-statement transactions per second over the 10-connection pool (1.3 ms per round
   trip). 50 busy rooms already need about 1,000, so the write queue grows without bound and
   edits take seconds to be acknowledged and delivered. With Neon over the internet, round
   trips are longer and the ceiling is lower.
2. **Then CPU, mostly socket writes.** With storage out of the way (memory-only), one
   process tops out at about 250 connections (7.5k cursor updates/s in). A CPU profile of
   that load (busy time):
   - 35% `writev`: one system call per message per recipient
   - about 20% zod validating incoming messages, nearly all of them cursor updates
   - the room logic itself (`updatePresence`, `commit`, `receive`) under 3%
3. **Cursor latency at light load is the throttle.** At 30 Hz senders and a 33 ms
   per-user presence throttle, updates often wait for the next slot. The p50 of about 20 ms
   is mostly that wait. Network and server processing alone are about 2 ms (seen in an
   early run where senders were accidentally slower than the throttle).
4. **Edit latency at light load is the group commit.** Edits are broadcast only once
   durable, so edit p50 (about 47 ms) is roughly half the 50 ms flush interval plus one
   Postgres transaction. This is the price of "never show an edit that could be lost".
5. **Memory per room is modest.** For 10 rooms with 50 sockets, heap grew 20 → 34 MB
   (about 1.4 MB per 5-client room) and RSS 82 → 126 MB (about 4 MB per room including
   socket buffers and GC headroom). Rough figures: rooms from earlier runs may still have
   been unloading.

### Fixes tried

All three are in the code; the sections below measure them.

1. **Group commit across rooms** (`GroupCommitPersister`): at most 4 transactions in
   flight; writes that arrive while they're busy share the next one.
2. **Presence batches**: one `presence-batch` message per room per 33 ms tick, serialized
   once and sent to every member (each skips its own entry). Clients opt in through
   `hello.batchPresence`; older clients still get one `presence` message per update.
3. **Hand-written presence validation**, checked against the zod schema by a property test.

## CPU fixes (2 and 3), memory-backed server (2026-11-18)

Raw output in `results/cpu-*`. Same machine, same session, three servers run back to back:
**old** is the code before the fixes (bundled from the previous commit), **new, old
clients** has the fixes but the clients don't ask for batches (so only the validation fix
applies), **new** has both. The old build doesn't report CPU (that field is new in
`/healthz`).

| Load | Old: cursor / edit p50 (p99) | New, old clients | New: cursor / edit p50 (p99) | Server CPU (new, old clients → new) |
|---|---|---|---|---|
| 50 × 5 | 23 / 38 ms (54 / 80) | 20 / 33 ms (49 / 67) | 18 / 32 ms (45 / 64) | 59% → 46% |
| 100 × 5 | 104 / 119 ms (157 / 212) | 40 / 48 ms (69 / 90) | 24 / 36 ms (51 / 72) | 101% → 80% |
| 200 × 5 | 387 / 293 ms (520 / 553) | 59 / 128 ms (202 / 246) | 53 / 106 ms (167 / 213) | 100% → 102% |
| 1 × 50 | 22 / 36 ms (46 / 72) | 39 / 35 ms (67 / 88) | 23 / 33 ms (51 / 68) | 64% → 8% |

- At 100 rooms (500 connections) the old server was already saturated and queueing; with
  both fixes, cursor p50 drops from 104 to 24 ms and there's CPU to spare.
- Batching matters most in big rooms: one room of 50 went from 64% to 8% CPU, because each
  member now gets about 30 messages a second instead of 49 × 30.
- 200 × 5 (1,000 connections) still saturates one core: cursor p50 is 7× and edit p50
  nearly 3× better than before, but latency is rising. That's the single-process ceiling on this laptop; going further
  means more processes (the multi-node work).
- The cost: a batch includes the sender's own update, which it ignores. In 5-person rooms
  that's about 20% more downstream bytes (16.3 → 19.7 KB/s per client at 50 × 5). Sending
  each member a batch without its own entry would save the bytes but mean one serialized
  message per member again.
- In the 1 × 50 runs of the old server and of old clients, the generator itself was near
  saturation (89% and 61% busy), so those latencies partly reflect its own delay. With
  batches it was 25% busy.

## Group commit (fix 1), Postgres (2026-11-18)

Raw output in `results/group-commit-{off,on}`. Both runs use the same build (with the CPU
fixes), back to back: `SYNC_GROUP_COMMIT=off` is one transaction per room flush, as before.
Docker's VM was capped at 4 GB and other containers were stopped. Without the cap, Docker
Desktop's VM crashed twice under these loads, so earlier attempts were discarded.

| Rooms × 5 | Off: edit p50 / p99 | On: edit p50 / p99 | Server CPU off → on |
|---|---|---|---|
| 10 | 46 / 80 ms | 42 / 75 ms | 23% → 20% |
| 50 | 71 / 380 ms | 52 / 282 ms | 88% → 66% |
| 100 | 1.2 s / 7.2 s | 255 / 584 ms | 90% → 98% |
| 200 | 26 s / 35 s | 1.7 s / 2.6 s | 87% → 100% |

- Off, edits fall apart from about 100 rooms: transactions queue faster than Postgres
  commits them. On, latency still rises with load but stays bounded, and at 50 rooms the
  server spends a quarter less CPU (fewer queries to build and parse).
- At 100 rooms and above, the server's CPU is now the limit (98–100%), not the database.
  Edits there are still slower than on the memory-backed server (36 ms p50 at 100 × 5),
  since every flush also builds and sends a transaction.
- At light load group commit costs nothing (10 rooms: 42 vs 46 ms p50).
- A first version allowed only one transaction in flight. It was slower than per-room
  transactions at light load (a write arriving just after a transaction started waited for
  all of it), so it now allows 4.

## Where this leaves one server

On this laptop, one sync process now handles 50 rooms of 5 (250 connections) on Postgres at
edit p50 52 ms and cursor p50 20 ms, and 100 rooms (500 connections) with edits under 0.6 s
at p99. The next limit is a single CPU core, which more processes (multi-node rooms) would
address.
