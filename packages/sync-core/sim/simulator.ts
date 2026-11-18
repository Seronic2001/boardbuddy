import { SyncClient } from "../src/client";
import { applyAll, canonical, readLayer, type Doc, type Json, type Op } from "../src/doc";
import type { ClientMessage, ServerMessage } from "../src/protocol";
import { Replica } from "../src/replica";
import { InMemoryPersister, LAYER_GONE, Room, type PersistBatch } from "../src/room";
import { orderedLayerIds, zKeyTop } from "../src/zorder";

/**
 * Deterministic network simulator. One seed fully determines the run: virtual time, the
 * event order, network faults and user actions all come from one PRNG, so any failure
 * replays exactly from its seed.
 *
 * It drives the real Room and SyncClient state machines over a network that delays,
 * reorders, duplicates and drops messages. Clients go offline (and keep editing), and the
 * server crashes and restarts from durable storage, losing any write still in flight.
 *
 * Checks:
 *  1. Durability: after every restart, the server has every op any client was acked for.
 *  2. Convergence: once faults stop and the system settles, every client equals the
 *     server, the server equals "apply every op ever generated, minus purged layers", and
 *     nothing is pending.
 *
 * Tombstone cleanup runs with a TTL of seconds instead of 30 days, so purges race with
 * offline clients that still edit, undo or restore the purged layers.
 */

export type SimConfig = {
  seed: number;
  clients: number;
  /** Total user actions across all clients (edits, gestures, undo, redo). */
  ops: number;
  drop: number;
  duplicate: number;
  reorder: number;
  /** Chance per client action of going offline for 0.5–8 s. */
  offline: number;
  /** Chance per server flush of the server crashing. */
  crash: number;
  /** Max clock skew per client, ms. */
  skewMs: number;
  catchupWindow: number;
  snapshotEvery: number;
  /** Deleted layers untouched this long (sim ms) are purged at the next snapshot. */
  tombstoneTtlMs: number;
};

export const defaultConfig: SimConfig = {
  seed: 1,
  clients: 8,
  ops: 5_000,
  drop: 0.05,
  duplicate: 0.05,
  reorder: 0.2,
  offline: 0.003,
  crash: 0.002,
  skewMs: 2_000,
  catchupWindow: 200,
  snapshotEvery: 100,
  tombstoneTtlMs: 5_000,
};

export type SimStats = {
  simTimeMs: number;
  events: number;
  messages: number;
  dropped: number;
  duplicated: number;
  crashes: number;
  offlinePeriods: number;
  snapshotCatchups: number;
  opsGenerated: number;
  undos: number;
  layers: number;
  purged: number;
  goneRejections: number;
};

export type SimResult =
  | { ok: true; stats: SimStats }
  | { ok: false; error: string; atMs: number; stats: SimStats };

// ---------------------------------------------------------------------------------------

/** mulberry32: small, fast, good enough for simulation. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
}

class EventQueue {
  private heap: { at: number; n: number; fn: () => void }[] = [];
  private counter = 0;
  now = 0;

  schedule(delay: number, fn: () => void): void {
    this.heap.push({ at: this.now + Math.max(0, delay), n: this.counter++, fn });
    let i = this.heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.less(p, i)) break;
      [this.heap[p], this.heap[i]] = [this.heap[i]!, this.heap[p]!];
      i = p;
    }
  }

  /** Runs the next event. Returns false when empty. */
  step(): boolean {
    const top = this.heap[0];
    if (!top) return false;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.heap.length && this.less(l, m)) m = l;
        if (r < this.heap.length && this.less(r, m)) m = r;
        if (m === i) break;
        [this.heap[m], this.heap[i]] = [this.heap[i]!, this.heap[m]!];
        i = m;
      }
    }
    this.now = top.at;
    top.fn();
    return true;
  }

  private less(a: number, b: number): boolean {
    const x = this.heap[a]!;
    const y = this.heap[b]!;
    return x.at < y.at || (x.at === y.at && x.n < y.n);
  }
}

class SimFailure extends Error {}

// ---------------------------------------------------------------------------------------

type SimClient = {
  id: string;
  sync: SyncClient;
  /** Connection epoch; messages from an older connection are discarded on delivery. */
  epoch: number;
  online: boolean;
  wantOnline: boolean;
  created: number;
  maxAcked: number;
};

const FLUSH_MS = 50;
const HELLO_MS = 1_000;
const SIM_EPOCH = 1_700_000_000_000;

export function runSimulation(partial: Partial<SimConfig> = {}): SimResult {
  const cfg: SimConfig = { ...defaultConfig, ...partial };
  const rng = new Rng(cfg.seed);
  const q = new EventQueue();
  const store = new InMemoryPersister();
  const stats: SimStats = {
    simTimeMs: 0,
    events: 0,
    messages: 0,
    dropped: 0,
    duplicated: 0,
    crashes: 0,
    offlinePeriods: 0,
    snapshotCatchups: 0,
    opsGenerated: 0,
    undos: 0,
    layers: 0,
    purged: 0,
    goneRejections: 0,
  };
  const purged = new Set<string>();
  const allOps: Op[] = [];
  let faults = true;
  let actionsLeft = cfg.ops;

  // ---- server -------------------------------------------------------------------------
  const roomOptions = {
    catchupWindow: cfg.catchupWindow,
    snapshotEvery: cfg.snapshotEvery,
    tombstoneTtlMs: cfg.tombstoneTtlMs,
    now: () => SIM_EPOCH + q.now,
  };
  let room: Room | null = new Room(store.load(), roomOptions);
  let serverEpoch = 0;

  const clients: SimClient[] = [];

  function deliver(delayBase: number, fn: () => void): void {
    stats.messages++;
    if (faults && rng.chance(cfg.drop)) {
      stats.dropped++;
      return;
    }
    const delay = () =>
      delayBase + rng.int(2, 30) + (faults && rng.chance(cfg.reorder) ? rng.int(0, 300) : 0);
    q.schedule(delay(), fn);
    if (faults && rng.chance(cfg.duplicate)) {
      stats.duplicated++;
      q.schedule(delay(), fn);
    }
  }

  function toServer(c: SimClient, msg: ClientMessage): void {
    const epoch = c.epoch;
    const sEpoch = serverEpoch;
    deliver(0, () => {
      if (c.epoch !== epoch || serverEpoch !== sEpoch || !room) return;
      room.receive(c.id, msg);
    });
  }

  function toClient(c: SimClient, epoch: number, sEpoch: number, msg: ServerMessage): void {
    deliver(0, () => {
      if (c.epoch !== epoch || serverEpoch !== sEpoch || !c.online) return;
      if (msg.t === "welcome" && msg.catchup.kind === "snapshot") stats.snapshotCatchups++;
      c.sync.onMessage(msg);
    });
  }

  function connect(c: SimClient): void {
    if (c.online || !c.wantOnline) return;
    if (!room) {
      q.schedule(rng.int(100, 1_000), () => connect(c)); // server down: retry with backoff
      return;
    }
    c.epoch++;
    c.online = true;
    const epoch = c.epoch;
    const sEpoch = serverEpoch;
    room.connect(c.id, (msg) => toClient(c, epoch, sEpoch, msg));
    c.sync.onOpen();
  }

  function disconnect(c: SimClient): void {
    if (!c.online) return;
    c.online = false;
    c.epoch++;
    room?.disconnect(c.id);
    c.sync.onClose();
  }

  function flush(): void {
    if (room) {
      const batch = room.takeBatch();
      if (batch) {
        const sEpoch = serverEpoch;
        // Durable write takes 2–20 ms; a crash in between loses it (never acked).
        q.schedule(rng.int(2, 20), () => commitWrite(batch, sEpoch));
      }
      if (faults && rng.chance(cfg.crash)) crash();
    }
    q.schedule(FLUSH_MS, flush);
  }

  function commitWrite(batch: PersistBatch, sEpoch: number): void {
    if (serverEpoch !== sEpoch || !room) return; // crashed mid-write
    store.write(batch);
    for (const e of batch.entries) {
      if (e.op.kind === "purge") {
        purged.add(e.op.layer);
        stats.purged++;
      }
    }
    room.commit(batch);
  }

  function crash(): void {
    stats.crashes++;
    serverEpoch++;
    room = null;
    for (const c of clients) {
      if (c.online) {
        c.online = false;
        c.epoch++;
        c.sync.onClose();
      }
    }
    q.schedule(rng.int(200, 2_000), () => {
      if (!room) restart(); // the settle phase may already have restarted it
    });
  }

  function restart(): void {
    room = new Room(store.load(), roomOptions);
    for (const c of clients) {
      if (room.durableCseq(c.id) < c.maxAcked) {
        throw new SimFailure(
          `Durability violated: ${c.id} was acked up to cseq ${c.maxAcked} but storage only has ${room.durableCseq(c.id)}`,
        );
      }
    }
    for (const c of clients) q.schedule(rng.int(50, 1_000), () => connect(c));
  }

  // ---- clients ------------------------------------------------------------------------
  for (let i = 0; i < cfg.clients; i++) {
    const id = `c${i}`;
    const skew = rng.int(-cfg.skewMs, cfg.skewMs);
    const replica = new Replica(id, { now: () => SIM_EPOCH + q.now + skew, limit: 100 });
    const c: SimClient = { id, epoch: 0, online: false, wantOnline: true, created: 0, maxAcked: 0, sync: null! };
    c.sync = new SyncClient(replica, (msg) => c.online && toServer(c, msg), {
      onAck: (upTo) => (c.maxAcked = Math.max(c.maxAcked, upTo)),
      onError: (cseq, message) => {
        // Expected: an edit (often an offline undo/redo) on a layer purged meanwhile.
        if (message === LAYER_GONE) {
          stats.goneRejections++;
          return;
        }
        throw new SimFailure(`${id} got an error for cseq ${cseq}: ${message}`);
      },
    });
    clients.push(c);
    q.schedule(rng.int(0, 100), () => connect(c));
    q.schedule(rng.int(0, 50), () => act(c));
    q.schedule(rng.int(0, HELLO_MS), () => heartbeat(c));
  }

  function heartbeat(c: SimClient): void {
    c.sync.hello();
    if (faults) q.schedule(HELLO_MS + rng.int(0, 200), () => heartbeat(c));
  }

  const record = (ops: Op[]) => {
    allOps.push(...ops);
    stats.opsGenerated += ops.length;
  };

  function act(c: SimClient): void {
    if (actionsLeft <= 0) return;
    actionsLeft--;
    const doc = c.sync.replica.doc;
    const visible = orderedLayerIds(doc);
    const r = rng.next();

    if (faults && rng.chance(cfg.offline) && c.online) {
      stats.offlinePeriods++;
      c.wantOnline = false;
      disconnect(c);
      q.schedule(rng.int(500, 8_000), () => {
        c.wantOnline = true;
        connect(c);
      });
    }

    if (visible.length === 0 || (r < 0.15 && visible.length < 40 && doc.layers.size < 120)) {
      const layer = `${c.id}-${++c.created}`;
      record(
        c.sync.mutate((tx) =>
          tx.create(layer, {
            type: rng.int(0, 4),
            x: rng.int(0, 1000),
            y: rng.int(0, 1000),
            width: rng.int(10, 300),
            height: rng.int(10, 300),
            fill: color(rng),
            z: zKeyTop(tx.doc),
          }),
        ),
      );
    } else if (r < 0.45) {
      const layer = rng.pick(visible);
      record(c.sync.mutate((tx) => tx.update(layer, { x: rng.int(0, 1000), y: rng.int(0, 1000) })));
    } else if (r < 0.58) {
      const layer = rng.pick(visible);
      record(c.sync.mutate((tx) => tx.set(layer, "fill", color(rng))));
    } else if (r < 0.68) {
      // Drag gesture: several moves grouped into one undo step.
      const layer = rng.pick(visible);
      c.sync.replica.history.pause();
      const start = readLayer(doc, layer)!;
      for (let i = 1; i <= rng.int(2, 6); i++) {
        record(c.sync.mutate((tx) => tx.update(layer, { x: num(start.x) + i * 5, y: num(start.y) + i * 3 })));
      }
      c.sync.replica.history.resume();
    } else if (r < 0.73) {
      const layer = rng.pick(visible);
      record(c.sync.mutate((tx) => tx.set(layer, "z", zKeyTop(tx.doc, layer))));
    } else if (r < 0.8) {
      const layer = rng.pick(visible);
      record(c.sync.mutate((tx) => tx.delete(layer)));
    } else if (r < 0.92) {
      stats.undos++;
      record(c.sync.undo());
    } else {
      record(c.sync.redo());
    }

    q.schedule(rng.int(5, 40) * cfg.clients, () => act(c));
  }

  // ---- run ----------------------------------------------------------------------------
  q.schedule(FLUSH_MS, flush);

  const settledAndConverged = (): string | null => {
    if (!room) return "server down";
    const target = canonical(room.committedDoc);
    for (const c of clients) {
      if (!c.online) return `${c.id} offline`;
      if (c.sync.pending.length > 0) return `${c.id} has ${c.sync.pending.length} pending ops`;
      if (c.sync.lastSeq !== room.seq) return `${c.id} at seq ${c.sync.lastSeq}, server at ${room.seq}`;
      if (canonical(c.sync.replica.doc) !== target) {
        return `${c.id} differs from server: ${firstDifference(c.sync.replica.doc, room.committedDoc)}`;
      }
    }
    const everything = applyAll({ layers: new Map() }, allOps);
    const expected = { layers: new Map([...everything.layers].filter(([id]) => !purged.has(id))) };
    if (canonical(expected) !== target) {
      return "server state differs from applying every generated op minus purged layers";
    }
    return null;
  };

  const MAX_SIM_MS = 3_600_000;
  try {
    // Phase 1: actions with faults.
    while (actionsLeft > 0 && q.now < MAX_SIM_MS) {
      if (!q.step()) break;
      stats.events++;
    }
    // Phase 2: heal the network and let everything settle.
    faults = false;
    if (!room) restart();
    for (const c of clients) {
      c.wantOnline = true;
      connect(c);
    }
    let lastProblem: string | null = "not checked";
    const deadline = q.now + 120_000;
    let nextCheck = q.now;
    while (q.now < deadline) {
      if (!q.step()) break;
      stats.events++;
      if (q.now >= nextCheck) {
        nextCheck = q.now + HELLO_MS;
        lastProblem = settledAndConverged();
        if (lastProblem === null) break;
        for (const c of clients) {
          connect(c);
          c.sync.hello();
        }
      }
    }
    stats.simTimeMs = q.now;
    stats.layers = room?.committedDoc.layers.size ?? 0;
    lastProblem = settledAndConverged();
    if (lastProblem !== null) {
      return { ok: false, error: `Did not converge: ${lastProblem}`, atMs: q.now, stats };
    }
    return { ok: true, stats };
  } catch (err) {
    stats.simTimeMs = q.now;
    if (err instanceof SimFailure) return { ok: false, error: err.message, atMs: q.now, stats };
    return { ok: false, error: `Exception: ${(err as Error).stack ?? err}`, atMs: q.now, stats };
  }
}

function firstDifference(a: Doc, b: Doc): string {
  for (const id of new Set([...a.layers.keys(), ...b.layers.keys()])) {
    const x = JSON.stringify(a.layers.get(id) ?? null);
    const y = JSON.stringify(b.layers.get(id) ?? null);
    if (x !== y) return `layer ${id}: ${x} vs ${y}`;
  }
  return "no layer differs";
}

function color(rng: Rng): Json {
  return { r: rng.int(0, 255), g: rng.int(0, 255), b: rng.int(0, 255) };
}

function num(v: Json | undefined): number {
  return typeof v === "number" ? v : 0;
}
