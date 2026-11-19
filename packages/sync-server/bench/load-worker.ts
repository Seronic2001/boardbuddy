/**
 * One load-generator thread: runs whole rooms (every client of a room lives in the same
 * thread, so sender and receiver share a clock), drives cursors and edits, and reports
 * histograms and counters back to the main thread.
 */
import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { importPKCS8, SignJWT, type CryptoKey } from "jose";
import WebSocket from "ws";
import { Replica, SyncClient, type TransportServerMessage } from "@boardbuddy/sync-core";
import { Histogram } from "./histogram";

export type WorkerConfig = {
  url: string;
  /** Sent as the Origin header; must be in the server's ALLOWED_ORIGINS. */
  origin: string;
  rooms: string[];
  clientsPerRoom: number;
  cursorHz: number;
  editHz: number;
  privateKeyPem: string;
  /** Behave like a client from before presence batches (one message per update). */
  legacyPresence: boolean;
  /** Spread connection setup over this long, so the server isn't hit by one burst. */
  rampMs: number;
};

export type WorkerCounters = {
  connected: number;
  failedConnects: number;
  unexpectedCloses: number;
  serverErrors: number;
  presenceSent: number;
  editsSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
};

export type ToWorker = { t: "start-measuring" } | { t: "stop" };
export type FromWorker =
  | { t: "ready"; connected: number; failed: number }
  | {
      t: "result";
      cursor: ReturnType<Histogram["toJSON"]>;
      edit: ReturnType<Histogram["toJSON"]>;
      ack: ReturnType<Histogram["toJSON"]>;
      counters: WorkerCounters;
      /** Share of the measured window this thread was busy (0..1). */
      utilization: number;
    };

const config = workerData as WorkerConfig;
const port = parentPort!;
const now = () => performance.timeOrigin + performance.now();

const cursor = new Histogram();
const edit = new Histogram();
const ack = new Histogram();
const counters: WorkerCounters = {
  connected: 0,
  failedConnects: 0,
  unexpectedCloses: 0,
  serverErrors: 0,
  presenceSent: 0,
  editsSent: 0,
  messagesReceived: 0,
  bytesSent: 0,
  bytesReceived: 0,
};
let measuring = false;
let stopping = false;

let eluStart = performance.eventLoopUtilization();

class LoadClient {
  private socket!: WebSocket;
  private readonly sync: SyncClient;
  private readonly layer: string;
  private readonly sentAt = new Map<number, number>(); // cseq -> send time

  constructor(
    private readonly userId: string,
    private readonly tab: string,
    private readonly token: string,
  ) {
    this.layer = `bench-${userId}`;
    this.sync = new SyncClient(
      new Replica(this.key, { limit: 1 }),
      (msg) =>
        this.send(
          msg.t === "hello"
            ? { ...msg, token: this.token, tab: this.tab, ...(config.legacyPresence ? {} : { batchPresence: true }) }
            : msg,
        ),
      {
        onAck: (upTo) => {
          for (const [cseq, at] of this.sentAt) {
            if (cseq > upTo) break;
            if (measuring) ack.record(now() - at);
            this.sentAt.delete(cseq);
          }
        },
        onError: () => counters.serverErrors++,
      },
    );
  }

  get key(): string {
    return `${this.userId}~${this.tab}`;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(config.url, { origin: config.origin });
      this.socket = socket;
      let welcomed = false;
      socket.on("open", () => this.sync.onOpen());
      socket.on("message", (data: Buffer) => {
        counters.messagesReceived++;
        counters.bytesReceived += data.length;
        const msg = JSON.parse(data.toString()) as TransportServerMessage;
        this.onMessage(msg);
        if (msg.t === "welcome" && !welcomed) {
          welcomed = true;
          resolve();
        }
      });
      socket.on("error", (err) => {
        if (!welcomed) reject(err);
      });
      socket.on("close", (code) => {
        this.sync.onClose();
        if (!welcomed) reject(new Error(`closed before welcome (${code})`));
        else if (!stopping) counters.unexpectedCloses++;
      });
    });
  }

  private nextCursor = Infinity;
  private nextEdit = Infinity;

  /** Creates this client's layer and schedules cursors and edits with a random phase. */
  start(t: number): void {
    this.sync.mutate((tx) => tx.create(this.layer, { x: 0, y: 0, stamp: 0 }));
    if (config.cursorHz > 0) this.nextCursor = t + Math.random() * (1000 / config.cursorHz);
    if (config.editHz > 0) this.nextEdit = t + Math.random() * (1000 / config.editHz);
  }

  /**
   * Sends everything that has come due. Timers are coarse (about 15.6 ms on Windows), so
   * per-client setIntervals undershoot the rate; catching up on each tick keeps the
   * average rate exact.
   */
  tick(t: number): void {
    while (this.nextCursor <= t) {
      counters.presenceSent++;
      this.send({ t: "presence", data: { cursor: { x: Math.random() * 1000, y: Math.random() * 1000 }, sentAt: now() } });
      this.nextCursor += 1000 / config.cursorHz;
    }
    while (this.nextEdit <= t) {
      counters.editsSent++;
      const at = now();
      this.sync.mutate((tx) => tx.set(this.layer, "stamp", at));
      this.sentAt.set(this.sync.exportState().nextCseq - 1, at);
      this.nextEdit += 1000 / config.editHz;
    }
  }

  close(): void {
    this.socket.close(1000);
  }

  private send(msg: object): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(msg);
    counters.bytesSent += Buffer.byteLength(text);
    this.socket.send(text);
  }

  private onMessage(msg: TransportServerMessage): void {
    switch (msg.t) {
      case "presence": {
        const sentAt = (msg.data as { sentAt?: number }).sentAt;
        if (measuring && typeof sentAt === "number") cursor.record(now() - sentAt);
        break;
      }
      case "presence-batch":
        if (measuring) {
          const t = now();
          for (const u of msg.updates) {
            const sentAt = (u.data as { sentAt?: number }).sentAt;
            if (u.id !== this.key && typeof sentAt === "number") cursor.record(t - sentAt);
          }
        }
        break;
      case "ops":
        if (measuring) {
          const t = now();
          for (const op of msg.batch) {
            if (op.kind === "set" && op.field === "stamp" && op.ts.client !== this.key && typeof op.v === "number") {
              edit.record(t - op.v);
            }
          }
        }
        this.sync.onMessage(msg);
        break;
      case "welcome":
      case "ack":
      case "error":
        this.sync.onMessage(msg);
        break;
      case "fatal":
        counters.serverErrors++;
        break;
    }
  }
}

async function token(key: CryptoKey, boardId: string, userId: string): Promise<string> {
  return new SignJWT({ boardId, orgId: "org_bench", role: "editor", name: userId })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(userId)
    .setIssuer("boardbuddy")
    .setAudience("buddysync")
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(key);
}

async function main() {
  const key = await importPKCS8(config.privateKeyPem.replace(/\\n/g, "\n"), "EdDSA");
  const clients: LoadClient[] = [];
  const total = config.rooms.length * config.clientsPerRoom;
  const gap = total > 1 ? config.rampMs / total : 0;

  const connecting: Promise<void>[] = [];
  for (const boardId of config.rooms) {
    for (let c = 0; c < config.clientsPerRoom; c++) {
      const userId = `user_${boardId}_${c}`;
      const client = new LoadClient(userId, `tab${String(c).padStart(6, "0")}`, await token(key, boardId, userId));
      connecting.push(
        client.connect().then(
          () => {
            counters.connected++;
            clients.push(client);
          },
          (err: unknown) => {
            if (counters.failedConnects++ === 0) console.error(`connect failed: ${String(err)}`);
          },
        ),
      );
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
  }
  await Promise.all(connecting);
  const t0 = now();
  for (const c of clients) c.start(t0);
  const ticker = setInterval(() => {
    const t = now();
    for (const c of clients) c.tick(t);
  }, 5);
  port.postMessage({ t: "ready", connected: counters.connected, failed: counters.failedConnects } satisfies FromWorker);

  port.on("message", (msg: ToWorker) => {
    if (msg.t === "start-measuring") {
      // Count only what happens inside the measured window.
      for (const k of Object.keys(counters) as (keyof WorkerCounters)[]) {
        if (k !== "connected" && k !== "failedConnects") counters[k] = 0;
      }
      eluStart = performance.eventLoopUtilization();
      measuring = true;
    } else {
      measuring = false;
      stopping = true;
      clearInterval(ticker);
      const utilization = performance.eventLoopUtilization(eluStart).utilization;
      for (const c of clients) c.close();
      port.postMessage({
        t: "result",
        cursor: cursor.toJSON(),
        edit: edit.toJSON(),
        ack: ack.toJSON(),
        counters,
        utilization,
      } satisfies FromWorker);
    }
  });
}

void main();
