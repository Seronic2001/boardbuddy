import {
  CloseCode,
  DEFAULT_TOMBSTONE_TTL_MS,
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
import { matches, type Revocation } from "./revocations";

/** One live socket, already authenticated. */
export interface Session {
  /** `${userId}~${tab}`: the client id for cseq dedup and the required op author. */
  readonly key: string;
  claims: RoomClaims;
  send(msg: TransportServerMessage): void;
  /** Sends an already serialized message, so one JSON string can go to many sessions. */
  sendText(text: string): void;
  /** Understands `presence-batch` (see sync-core protocol.ts). */
  batchPresence: boolean;
  close(code: number, reason: string): void;
}

export type RoomHostOptions = {
  flushMs?: number;
  presenceIntervalMs?: number;
  presenceGraceMs?: number;
  idleMs?: number;
  maxLayers?: number;
  maxSkewMs?: number;
  /** Deleted layers untouched this long are purged at compaction. Default 30 days. */
  tombstoneTtlMs?: number;
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
};

type PresenceSlot = {
  entry: PresenceEntry;
  /** Changes not yet broadcast. */
  outgoing: Record<string, unknown> | null;
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
  private readonly dirtyPresence = new Set<string>();
  private presenceTimer: NodeJS.Timeout | null = null;
  private lastPresenceAt = 0;
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
      tombstoneTtlMs: DEFAULT_TOMBSTONE_TTL_MS,
      now: Date.now,
      ...options,
    };
    this.room = new Room(state, {
      validate: (op, client, doc) => this.validate(op, client, doc),
      tombstoneTtlMs: this.opts.tombstoneTtlMs,
      now: this.opts.now,
    });
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
      this.presence.set(session.key, { entry, outgoing: null, removeTimer: null });
      this.broadcast({ t: "presence-join", entry }, session.key);
    }
  }

  /**
   * `deliberate`: the client closed on purpose (left the board, closed the tab), so others
   * see it leave at once. Otherwise the presence lingers for presenceGraceMs in case the
   * connection comes straight back.
   */
  leave(session: Session, { deliberate = false }: { deliberate?: boolean } = {}): void {
    if (this.sessions.get(session.key) !== session) return; // already replaced
    this.sessions.delete(session.key);
    this.room.disconnect(session.key);
    const slot = this.presence.get(session.key);
    if (slot) {
      const remove = () => {
        this.presence.delete(session.key);
        this.broadcast({ t: "presence-leave", id: session.key });
      };
      if (deliberate) {
        remove();
      } else {
        slot.removeTimer = setTimeout(remove, this.opts.presenceGraceMs);
        slot.removeTimer.unref();
      }
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
          // Both are needed to recover after a restore from backup (see sync-core protocol.ts).
          ...(msg.lastTs ? { lastTs: msg.lastTs } : {}),
          ...(msg.nextCseq !== undefined ? { nextCseq: msg.nextCseq } : {}),
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

  /** Closes every session the revocation covers. Returns how many were closed. */
  revoke(r: Revocation): number {
    let closed = 0;
    for (const session of [...this.sessions.values()]) {
      if (!matches(r, session.claims)) continue;
      session.send({ t: "fatal", code: "UNAUTHORIZED", message: "Access revoked" });
      session.close(CloseCode.Unauthorized, "Access revoked");
      closed++;
    }
    return closed;
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
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    for (const slot of this.presence.values()) {
      if (slot.removeTimer) clearTimeout(slot.removeTimer);
    }
    try {
      // Drain: in-flight write first, then whatever is still buffered.
      for (let i = 0; i < 100; i++) {
        if (this.writing) await this.writing;
        const more = await this.flushOnce();
        if (!more && !this.writing) break;
      }
      // Compact on the way out (idle or shutdown): snapshot plus tombstone cleanup, so
      // quiet boards that never reach snapshotEvery ops still get cleaned up.
      if (!this.writing && this.failedWrites === 0) await this.flushOnce(true);
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
  private async flushOnce(compact = false): Promise<boolean> {
    if (this.writing) return false;
    const batch = this.room.takeBatch({ compact });
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
    this.dirtyPresence.add(key);
    // Throttle per room: at most one presence broadcast per interval, carrying every change
    // since the last one. The trailing change always goes out.
    if (this.presenceTimer) return;
    const wait = this.lastPresenceAt + this.opts.presenceIntervalMs - this.opts.now();
    if (wait <= 0) {
      this.sendPresence();
    } else {
      this.presenceTimer = setTimeout(() => {
        this.presenceTimer = null;
        this.sendPresence();
      }, wait);
      this.presenceTimer.unref();
    }
  }

  /**
   * One serialized batch for every client that understands it (each skips its own entry),
   * instead of one message per change per recipient: socket writes were the server's
   * biggest CPU cost under load. Older clients get the per-change messages they expect.
   */
  private sendPresence(): void {
    const updates: { id: string; data: PresenceData }[] = [];
    for (const key of this.dirtyPresence) {
      const slot = this.presence.get(key);
      if (slot?.outgoing) updates.push({ id: key, data: slot.outgoing });
      if (slot) slot.outgoing = null;
    }
    this.dirtyPresence.clear();
    if (updates.length === 0) return;
    this.lastPresenceAt = this.opts.now();

    let batch: string | null = null;
    let single: Map<string, string> | null = null;
    for (const [key, s] of this.sessions) {
      if (s.batchPresence) {
        batch ??= JSON.stringify({ t: "presence-batch", updates } satisfies TransportServerMessage);
        s.sendText(batch);
      } else {
        single ??= new Map(
          updates.map((u) => [u.id, JSON.stringify({ t: "presence", ...u } satisfies TransportServerMessage)]),
        );
        for (const [id, text] of single) if (id !== key) s.sendText(text);
      }
    }
  }

  private broadcast(msg: TransportServerMessage, exceptKey?: string): void {
    let text: string | null = null;
    for (const [key, s] of this.sessions) {
      if (key === exceptKey) continue;
      text ??= JSON.stringify(msg);
      s.sendText(text);
    }
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
