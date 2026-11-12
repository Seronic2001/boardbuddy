import {
  CloseCode,
  Replica,
  SyncClient,
  type PresenceData,
  type PresenceEntry,
  type TransportServerMessage,
} from "@boardbuddy/sync-core";

/**
 * Browser side of BuddySync for one board. Owns the WebSocket lifecycle around the pure
 * SyncClient: authenticate → open → hello → live, then reconnect with backoff and jitter
 * when the socket drops, renew the token before it expires, and resync periodically.
 *
 * Edits never wait for the network. They apply to the local replica at once and queue
 * in the SyncClient until acked, so being offline is the same as being slow.
 */

export type AuthResult = {
  token: string;
  userId: string;
  /** ms since epoch */
  expiresAt: number;
  url: string;
  name?: string;
  picture?: string;
};

export class AuthRejectedError extends Error {
  constructor(message = "Not allowed to join this board") {
    super(message);
    this.name = "AuthRejectedError";
  }
}

export type ConnectionStatus =
  | "initial"
  | "authenticating"
  | "connecting"
  | "synchronizing"
  | "connected"
  | "reconnecting"
  /** Terminal: auth was refused or the tab connected again elsewhere. */
  | "disconnected";

export type ConnectionOptions = {
  boardId: string;
  /** Throw AuthRejectedError when access is denied for good (no retry). */
  authenticate: (boardId: string) => Promise<AuthResult>;
  /** Stable per browser tab; keeps cseq dedup and presence identity across reconnects. */
  tabId?: string;
  WebSocketImpl?: typeof WebSocket;
  presenceThrottleMs?: number;
  heartbeatMs?: number;
  /** Renew the token this long before it expires. */
  renewBeforeMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
};

type Listener = () => void;

export class BuddySyncConnection {
  private replicaValue: Replica | null = null;
  private syncValue: SyncClient | null = null;
  private auth: AuthResult | null = null;
  private socket: WebSocket | null = null;
  private statusValue: ConnectionStatus = "initial";
  private loaded = false;
  private stopped = false;
  private attempt = 0;
  private presence: PresenceData = {};
  private outgoingPresence: Record<string, unknown> | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPresenceSentAt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private othersValue: ReadonlyMap<string, PresenceEntry> = new Map();
  private selfKey: string | null = null;
  private readonly listeners = { status: new Set<Listener>(), presence: new Set<Listener>(), loaded: new Set<Listener>() };

  readonly tabId: string;
  private readonly opts: Required<Omit<ConnectionOptions, "tabId" | "WebSocketImpl">> & {
    WebSocketImpl: typeof WebSocket;
  };

  constructor(options: ConnectionOptions) {
    this.tabId = options.tabId ?? randomTabId();
    this.opts = {
      presenceThrottleMs: 30,
      heartbeatMs: 10_000,
      renewBeforeMs: 60_000,
      maxBackoffMs: 10_000,
      random: Math.random,
      WebSocketImpl: options.WebSocketImpl ?? globalThis.WebSocket,
      ...options,
    } as BuddySyncConnection["opts"];
  }

  // ---- public state -------------------------------------------------------------------

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  /** Null until the first successful authentication (the replica id needs the user id). */
  get replica(): Replica | null {
    return this.replicaValue;
  }

  get sync(): SyncClient | null {
    return this.syncValue;
  }

  get user(): AuthResult | null {
    return this.auth;
  }

  /** True once the first catch-up from the server has been applied. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  get myPresence(): PresenceData {
    return this.presence;
  }

  /** Other connections in the room, keyed by `${userId}~${tabId}`. */
  get others(): ReadonlyMap<string, PresenceEntry> {
    return this.othersValue;
  }

  get key(): string | null {
    return this.selfKey;
  }

  on(event: keyof BuddySyncConnection["listeners"], listener: Listener): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  // ---- lifecycle ----------------------------------------------------------------------

  start(): void {
    if (this.statusValue !== "initial") return;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Client closed");
    this.syncValue?.onClose();
    this.setStatus("disconnected");
  }

  /** Reconnect now (e.g. the browser came back online) instead of waiting for the backoff. */
  reconnectNow(): void {
    if (this.stopped || this.statusValue !== "reconnecting") return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.connect();
  }

  updatePresence(patch: PresenceData): void {
    this.presence = { ...this.presence, ...patch };
    this.outgoingPresence = { ...this.outgoingPresence, ...patch };
    this.emit("presence");
    this.schedulePresenceFlush();
  }

  // ---- internals ----------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.setStatus(this.attempt === 0 && !this.loaded ? "authenticating" : "reconnecting");
    let auth: AuthResult;
    try {
      auth = await this.opts.authenticate(this.opts.boardId);
    } catch (err) {
      if (err instanceof AuthRejectedError) return this.stop();
      return this.scheduleRetry();
    }
    if (this.stopped) return;
    if (this.auth && this.auth.userId !== auth.userId) {
      // A different user signed in in this tab; this replica belongs to someone else.
      return this.stop();
    }
    this.auth = auth;
    this.ensureReplica(auth.userId);
    this.setStatus("connecting");

    const socket = new this.opts.WebSocketImpl(auth.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.setStatus("synchronizing");
      this.syncValue!.onOpen(); // sends hello (token and tab are added in send())
      this.scheduleRenewal();
      this.heartbeatTimer ??= setInterval(() => this.syncValue?.hello(), this.opts.heartbeatMs);
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.onMessage(JSON.parse(String(event.data)) as TransportServerMessage);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.syncValue?.onClose();
      this.onSocketClosed(event.code);
    };
    socket.onerror = () => {
      // A close event always follows; handle everything there.
    };
  }

  private ensureReplica(userId: string): void {
    if (this.replicaValue) return;
    const replica = new Replica(`${userId}~${this.tabId}`);
    this.replicaValue = replica;
    this.syncValue = new SyncClient(replica, (msg) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== socket.OPEN) return;
      const out = msg.t === "hello" ? { ...msg, token: this.auth?.token, tab: this.tabId } : msg;
      socket.send(JSON.stringify(out));
    });
  }

  private onMessage(msg: TransportServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.syncValue!.onMessage(msg);
        this.attempt = 0;
        this.setStatus("connected");
        if (!this.loaded) {
          this.loaded = true;
          this.emit("loaded");
        }
        break;
      case "ack":
      case "ops":
      case "error":
        this.syncValue!.onMessage(msg);
        break;
      case "presence-state": {
        this.selfKey = msg.self;
        this.othersValue = new Map(msg.others.map((e) => [e.id, e]));
        this.emit("presence");
        // The server may have dropped our presence; send all of it again.
        this.outgoingPresence = { ...this.presence };
        this.flushPresence();
        break;
      }
      case "presence-join":
        this.setOthers((m) => m.set(msg.entry.id, msg.entry));
        break;
      case "presence": {
        const entry = this.othersValue.get(msg.id);
        if (entry) this.setOthers((m) => m.set(msg.id, { ...entry, data: { ...entry.data, ...msg.data } }));
        break;
      }
      case "presence-leave":
        this.setOthers((m) => m.delete(msg.id));
        break;
      case "read-only":
      case "fatal":
        break; // the close event that follows a fatal decides what to do
    }
  }

  private onSocketClosed(code: number): void {
    this.clearConnectionTimers();
    if (this.stopped) return;
    if (code === CloseCode.Replaced) return this.stop();
    if (this.othersValue.size > 0) {
      this.othersValue = new Map();
      this.emit("presence");
    }
    // Unauthorized/TokenExpired: the next connect() fetches a fresh token, and a real
    // denial surfaces there as AuthRejectedError.
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    this.setStatus("reconnecting");
    const base = Math.min(this.opts.maxBackoffMs, 250 * 2 ** this.attempt);
    const delay = base / 2 + this.opts.random() * (base / 2); // jitter: [base/2, base)
    this.attempt++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private scheduleRenewal(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (!this.auth) return;
    const wait = Math.max(1_000, this.auth.expiresAt - Date.now() - this.opts.renewBeforeMs);
    this.renewTimer = setTimeout(async () => {
      try {
        const auth = await this.opts.authenticate(this.opts.boardId);
        if (auth.userId !== this.auth?.userId) return; // let the expiry close it
        this.auth = auth;
        this.socket?.send(JSON.stringify({ t: "reauth", token: auth.token }));
        this.scheduleRenewal();
      } catch {
        // The server closes the socket at expiry; connect() then retries auth.
      }
    }, wait);
  }

  private schedulePresenceFlush(): void {
    if (this.presenceTimer) return;
    const wait = this.lastPresenceSentAt + this.opts.presenceThrottleMs - Date.now();
    if (wait <= 0) return this.flushPresence();
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.flushPresence();
    }, wait);
  }

  private flushPresence(): void {
    const socket = this.socket;
    if (!this.outgoingPresence || !socket || socket.readyState !== socket.OPEN || !this.selfKey) return;
    socket.send(JSON.stringify({ t: "presence", data: this.outgoingPresence }));
    this.outgoingPresence = null;
    this.lastPresenceSentAt = Date.now();
  }

  private setOthers(change: (m: Map<string, PresenceEntry>) => void): void {
    const next = new Map(this.othersValue);
    change(next);
    this.othersValue = next;
    this.emit("presence");
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.emit("status");
  }

  private emit(event: keyof BuddySyncConnection["listeners"]): void {
    for (const l of this.listeners[event]) l();
  }

  private clearConnectionTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.heartbeatTimer = this.renewTimer = this.presenceTimer = null;
  }

  private clearTimers(): void {
    this.clearConnectionTimers();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

function randomTabId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
