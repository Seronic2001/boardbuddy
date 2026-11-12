import {
  CloseCode,
  isVisible,
  Room,
  type Doc,
  type Op,
  type PersistBatch,
  type PresenceData,
  type PresenceEntry,
  type TransportClientMessage,
  type TransportServerMessage,
} from "@boardbuddy/sync-core";
import type { RoomClaims } from "./auth";
import type { Persister } from "./persister";

/** One live socket, already authenticated. */
export interface Session {
  /** `${userId}~${tab}`: the client id for cseq dedup and the required op author. */
  readonly key: string;
  claims: RoomClaims;
  send(msg: TransportServerMessage): void;
  close(code: number, reason: string): void;
}

export type RoomHostOptions = {
  flushMs?: number;
  presenceIntervalMs?: number;
  presenceGraceMs?: number;
  idleMs?: number;
  maxLayers?: number;
  maxSkewMs?: number;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
};

type PresenceSlot = {
  entry: PresenceEntry;
  outgoing: Record<string, unknown> | null;
  lastSentAt: number;
  timer: NodeJS.Timeout | null;
  removeTimer: NodeJS.Timeout | null;
};

const PATH_LAYER_TYPE = 2; // LayerType.Path in types/canvas.ts

/**
 * Hosts one board: the Room state machine, its sessions, presence, and the group-commit
 * loop. Every `flushMs` it takes the room's pending batch, writes it in one transaction,
 * and only then commits it (acks + broadcast).
 */
export class RoomHost {
  readonly room: Room;
  private readonly sessions = new Map<string, Session>();
  private readonly presence = new Map<string, PresenceSlot>();
  private readonly flushTimer: NodeJS.Timeout;
  private idleTimer: NodeJS.Timeout | null = null;
  private writing: Promise<void> | null = null;
  private failedWrites = 0;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  private readonly opts: Required<Omit<RoomHostOptions, "log">> & Pick<RoomHostOptions, "log">;

  constructor(
    readonly boardId: string,
    state: Awaited<ReturnType<Persister["load"]>>,
    private readonly persister: Persister,
    /** Called once when the host starts shutting down, with a promise for when it is done. */
    private readonly onDispose: (host: RoomHost, done: Promise<void>) => void,
    options: RoomHostOptions = {},
  ) {
    this.opts = {
      flushMs: 50,
      presenceIntervalMs: 33,
      presenceGraceMs: 5_000,
      idleMs: 30_000,
      maxLayers: 100,
      maxSkewMs: 60_000,
      now: Date.now,
      ...options,
    };
    this.room = new Room(state, { validate: (op, client, doc) => this.validate(op, client, doc) });
    this.flushTimer = setInterval(() => void this.flush(), this.opts.flushMs);
    this.flushTimer.unref();
    this.armIdleTimer();
  }

  get connectionCount(): number {
    return this.sessions.size;
  }

  join(session: Session): void {
    if (this.disposed) {
      session.close(CloseCode.RoomUnavailable, "Room is shutting down");
      return;
    }
    const previous = this.sessions.get(session.key);
    if (previous && previous !== session) {
      previous.send({ t: "fatal", code: "REPLACED", message: "Same tab connected again" });
      previous.close(CloseCode.Replaced, "Replaced by a newer connection");
    }
    this.sessions.set(session.key, session);
    this.clearIdleTimer();
    this.room.connect(session.key, (msg) => session.send(msg));

    const others = [...this.presence.values()]
      .filter((p) => p.entry.id !== session.key && !p.removeTimer)
      .map((p) => p.entry);
    session.send({ t: "presence-state", self: session.key, others });

    const slot = this.presence.get(session.key);
    if (slot?.removeTimer) {
      // Quick reconnect: keep the presence, no leave/join flicker for others.
      clearTimeout(slot.removeTimer);
      slot.removeTimer = null;
    } else if (!slot) {
      const { userId, name, picture } = session.claims;
      const entry: PresenceEntry = {
        id: session.key,
        user: picture ? { userId, name, picture } : { userId, name },
        data: {},
      };
      this.presence.set(session.key, { entry, outgoing: null, lastSentAt: 0, timer: null, removeTimer: null });
      this.broadcast({ t: "presence-join", entry }, session.key);
    }
  }

  leave(session: Session): void {
    if (this.sessions.get(session.key) !== session) return; // already replaced
    this.sessions.delete(session.key);
    this.room.disconnect(session.key);
    const slot = this.presence.get(session.key);
    if (slot) {
      slot.removeTimer = setTimeout(() => {
        if (slot.timer) clearTimeout(slot.timer);
        this.presence.delete(session.key);
        this.broadcast({ t: "presence-leave", id: session.key });
      }, this.opts.presenceGraceMs);
      slot.removeTimer.unref();
    }
    if (this.sessions.size === 0) this.armIdleTimer();
  }

  receive(session: Session, msg: TransportClientMessage): void {
    if (this.sessions.get(session.key) !== session) return;
    switch (msg.t) {
      case "hello":
        this.room.receive(session.key, {
          t: "hello",
          lastSeq: msg.lastSeq,
          pending: session.claims.role === "viewer" ? [] : msg.pending,
        });
        break;
      case "ops":
        if (session.claims.role === "viewer") {
          session.send({ t: "read-only", cseq: msg.batch[0]?.cseq ?? 0 });
          return;
        }
        this.room.receive(session.key, { t: "ops", batch: msg.batch });
        break;
      case "presence":
        this.updatePresence(session.key, msg.data);
        break;
      case "reauth":
        break; // handled by the connection
    }
  }

  /** Writes everything accepted so far, then stops. Used on idle and on shutdown. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposal = this.drainAndClose();
    this.onDispose(this, this.disposal);
    return this.disposal;
  }

  private async drainAndClose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.flushTimer);
    this.clearIdleTimer();
    for (const slot of this.presence.values()) {
      if (slot.timer) clearTimeout(slot.timer);
      if (slot.removeTimer) clearTimeout(slot.removeTimer);
    }
    try {
      // Drain: in-flight write first, then whatever is still buffered.
      for (let i = 0; i < 100; i++) {
        if (this.writing) await this.writing;
        const more = await this.flushOnce();
        if (!more && !this.writing) break;
      }
    } finally {
      for (const s of this.sessions.values()) s.close(CloseCode.RoomUnavailable, "Room closed");
      this.sessions.clear();
    }
  }

  // -------------------------------------------------------------------------------------

  private async flush(): Promise<void> {
    if (this.writing || this.disposed) return;
    await this.flushOnce();
  }

  /** Returns true if a batch was written. */
  private async flushOnce(): Promise<boolean> {
    if (this.writing) return false;
    const batch = this.room.takeBatch();
    if (!batch) return false;
    this.writing = this.writeWithRetry(batch).finally(() => (this.writing = null));
    await this.writing;
    return true;
  }

  private async writeWithRetry(batch: PersistBatch): Promise<void> {
    for (;;) {
      try {
        await this.persister.write(this.boardId, batch);
        this.failedWrites = 0;
        this.room.commit(batch);
        return;
      } catch (err) {
        this.failedWrites++;
        this.opts.log?.("persist_failed", { boardId: this.boardId, attempt: this.failedWrites, error: String(err) });
        if (this.failedWrites >= 5) {
          // Give up: drop the room without acking. Clients keep the ops pending and resend
          // them to whichever room instance loads next.
          this.failRoom();
          return;
        }
        await new Promise((r) => setTimeout(r, 50 * 2 ** this.failedWrites));
      }
    }
  }

  private failRoom(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposal = Promise.resolve();
    clearInterval(this.flushTimer);
    this.clearIdleTimer();
    for (const s of this.sessions.values()) {
      s.send({ t: "fatal", code: "ROOM_UNAVAILABLE", message: "Storage unavailable" });
      s.close(CloseCode.RoomUnavailable, "Storage unavailable");
    }
    this.sessions.clear();
    this.onDispose(this, this.disposal);
  }

  private validate(op: Op, client: string, doc: Doc): string | null {
    if (op.ts.client !== client) return "Op author does not match this connection";
    if (op.ts.wall > this.opts.now() + this.opts.maxSkewMs) return "Clock skew too large";
    const existing = doc.layers.get(op.layer);
    if (op.kind === "create" && !existing) {
      let visible = 0;
      for (const record of doc.layers.values()) if (isVisible(record)) visible++;
      if (visible >= this.opts.maxLayers) return "LAYER_CAP";
    }
    if (op.kind === "set" && op.field === "points" && existing?.fields.type?.v === PATH_LAYER_TYPE) {
      return "Path points are immutable";
    }
    return null;
  }

  private updatePresence(key: string, patch: PresenceData): void {
    const slot = this.presence.get(key);
    if (!slot) return;
    slot.entry = { ...slot.entry, data: { ...slot.entry.data, ...patch } };
    slot.outgoing = { ...slot.outgoing, ...patch };
    // Throttle per user: at most one broadcast per interval; the trailing update always goes out.
    if (slot.timer) return;
    const wait = slot.lastSentAt + this.opts.presenceIntervalMs - this.opts.now();
    if (wait <= 0) {
      this.sendPresence(key, slot);
    } else {
      slot.timer = setTimeout(() => {
        slot.timer = null;
        this.sendPresence(key, slot);
      }, wait);
      slot.timer.unref();
    }
  }

  private sendPresence(key: string, slot: PresenceSlot): void {
    if (!slot.outgoing || !this.presence.has(key)) return;
    const data = slot.outgoing;
    slot.outgoing = null;
    slot.lastSentAt = this.opts.now();
    this.broadcast({ t: "presence", id: key, data }, key);
  }

  private broadcast(msg: TransportServerMessage, exceptKey?: string): void {
    for (const [key, s] of this.sessions) if (key !== exceptKey) s.send(msg);
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.sessions.size === 0) void this.dispose();
    }, this.opts.idleMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
