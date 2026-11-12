import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { CloseCode, type FatalCode, type TransportServerMessage } from "@boardbuddy/sync-core";
import { AuthError, verifyRoomToken, type PublicKey, type RoomClaims } from "./auth";
import type { Persister } from "./persister";
import { RoomHost, type RoomHostOptions, type Session } from "./room-host";
import { parseClientMessage } from "./schema";

export type SyncServerOptions = {
  port?: number;
  host?: string;
  publicKey: PublicKey;
  persister: Persister;
  /** Browser origins allowed to connect. Empty or undefined = allow any (dev only). */
  allowedOrigins?: string[];
  room?: RoomHostOptions;
  /** Max time between socket open and a valid hello. */
  helloTimeoutMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
};

export type SyncServer = {
  readonly port: number;
  readonly rooms: RoomManager;
  close(): Promise<void>;
};

/** Loads rooms on demand and makes sure at most one RoomHost per board exists. */
export class RoomManager {
  private readonly hosts = new Map<string, Promise<RoomHost>>();
  private readonly disposing = new Map<string, Promise<void>>();
  private readonly live = new Map<string, RoomHost>();

  constructor(
    private readonly persister: Persister,
    private readonly options: RoomHostOptions,
  ) {}

  get size(): number {
    return this.hosts.size;
  }

  async get(boardId: string): Promise<RoomHost> {
    let host = this.hosts.get(boardId);
    if (!host) {
      host = this.load(boardId);
      this.hosts.set(boardId, host);
      host.catch(() => this.hosts.delete(boardId));
    }
    return host;
  }

  async closeAll(): Promise<void> {
    const hosts = await Promise.allSettled([...this.hosts.values()]);
    await Promise.all(hosts.map((h) => (h.status === "fulfilled" ? h.value.dispose() : undefined)));
    await Promise.all(this.disposing.values());
  }

  private async load(boardId: string): Promise<RoomHost> {
    // A host that is still writing its final batch must finish before we reload the board.
    await this.disposing.get(boardId);
    const state = await this.persister.load(boardId);
    const host = new RoomHost(
      boardId,
      state,
      this.persister,
      (disposed, done) => {
        if (this.live.get(boardId) === disposed) {
          this.live.delete(boardId);
          this.hosts.delete(boardId);
        }
        this.disposing.set(boardId, done);
        void done.finally(() => {
          if (this.disposing.get(boardId) === done) this.disposing.delete(boardId);
        });
      },
      this.options,
    );
    this.live.set(boardId, host);
    return host;
  }
}

export async function startSyncServer(options: SyncServerOptions): Promise<SyncServer> {
  const log = options.log ?? (() => {});
  const rooms = new RoomManager(options.persister, { ...options.room, log });
  const allowed = new Set(options.allowedOrigins?.filter(Boolean) ?? []);
  let connections = 0;

  const http: Server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server: http,
    maxPayload: 1024 * 1024,
    verifyClient: ({ req }: { req: IncomingMessage }) =>
      allowed.size === 0 || allowed.has(req.headers.origin ?? ""),
  });

  wss.on("connection", (socket) => {
    connections++;
    handleConnection(socket, options, rooms, log);
    socket.on("close", () => connections--);
  });

  // Drop sockets that stop answering pings (laptop closed, network gone).
  const alive = new WeakSet<WebSocket>();
  wss.on("connection", (socket) => {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  await new Promise<void>((resolve) => http.listen(options.port ?? 8787, options.host, resolve));
  const port = (http.address() as AddressInfo).port;

  let closing: Promise<void> | null = null;
  const close = async () => {
      clearInterval(heartbeat);
      await rooms.closeAll(); // flushes every room before closing sockets
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  return {
    port,
    rooms,
    close: () => (closing ??= close()),
  };
}

function handleConnection(
  socket: WebSocket,
  options: SyncServerOptions,
  rooms: RoomManager,
  log: NonNullable<SyncServerOptions["log"]>,
): void {
  let session: (Session & { host: RoomHost }) | null = null;
  let expiryTimer: NodeJS.Timeout | null = null;
  let closed = false;
  // Messages are handled strictly in order, even across the async auth and room load.
  let chain: Promise<void> = Promise.resolve();

  const send = (msg: TransportServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };
  const fatal = (code: FatalCode, closeCode: number, message: string) => {
    send({ t: "fatal", code, message });
    socket.close(closeCode, message);
  };
  const armExpiry = (claims: RoomClaims) => {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(
      () => fatal("TOKEN_EXPIRED", CloseCode.TokenExpired, "Token expired"),
      Math.max(0, claims.expiresAt - Date.now()),
    );
    expiryTimer.unref();
  };

  const helloTimer = setTimeout(
    () => fatal("UNAUTHORIZED", CloseCode.Unauthorized, "No hello received"),
    options.helloTimeoutMs ?? 10_000,
  );
  helloTimer.unref();

  socket.on("message", (data, isBinary) => {
    chain = chain.then(() => handle(isBinary ? "" : data.toString())).catch((err: unknown) => {
      log("connection_error", { error: String(err) });
      fatal("ROOM_UNAVAILABLE", CloseCode.RoomUnavailable, "Internal error");
    });
  });

  socket.on("close", () => {
    closed = true;
    clearTimeout(helloTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    if (session) session.host.leave(session);
  });

  async function handle(raw: string): Promise<void> {
    if (closed) return;
    const msg = parseClientMessage(raw);
    if (!msg) return fatal("BAD_MESSAGE", CloseCode.BadMessage, "Malformed message");

    if (!session) {
      if (msg.t !== "hello" || !msg.token || !msg.tab) {
        return fatal("UNAUTHORIZED", CloseCode.Unauthorized, "First message must be hello with token and tab");
      }
      let claims: RoomClaims;
      try {
        claims = await verifyRoomToken(msg.token, options.publicKey);
      } catch (err) {
        const expired = err instanceof AuthError && err.expired;
        return fatal(
          expired ? "TOKEN_EXPIRED" : "UNAUTHORIZED",
          expired ? CloseCode.TokenExpired : CloseCode.Unauthorized,
          (err as Error).message,
        );
      }
      const host = await rooms.get(claims.boardId);
      if (closed) return;
      clearTimeout(helloTimer);
      session = {
        key: `${claims.userId}~${msg.tab}`,
        claims,
        host,
        send,
        close: (code, reason) => socket.close(code, reason),
      };
      armExpiry(claims);
      host.join(session);
      log("join", { boardId: claims.boardId, key: session.key, role: claims.role });
      host.receive(session, msg);
      return;
    }

    if (msg.t === "reauth") {
      try {
        const claims = await verifyRoomToken(msg.token, options.publicKey);
        if (claims.userId !== session.claims.userId || claims.boardId !== session.claims.boardId) {
          return fatal("UNAUTHORIZED", CloseCode.Unauthorized, "Token is for a different user or board");
        }
        session.claims = claims;
        armExpiry(claims);
      } catch (err) {
        return fatal("UNAUTHORIZED", CloseCode.Unauthorized, (err as Error).message);
      }
      return;
    }
    session.host.receive(session, msg);
  }
}
