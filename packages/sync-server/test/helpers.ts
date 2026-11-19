import { generateKeyPair, SignJWT, type CryptoKey } from "jose";
import WebSocket from "ws";
import {
  Replica,
  SyncClient,
  type PresenceEntry,
  type TransportClientMessage,
  type TransportServerMessage,
} from "@boardbuddy/sync-core";
import { ADMIN_AUDIENCE, TOKEN_AUDIENCE, TOKEN_ISSUER } from "../src/auth";

export async function keyPair() {
  return generateKeyPair("EdDSA", { crv: "Ed25519" });
}

export type TokenClaims = {
  userId: string;
  boardId: string;
  orgId?: string;
  role?: "editor" | "viewer";
  name?: string;
  expiresInSec?: number;
};

export async function signToken(privateKey: CryptoKey, c: TokenClaims): Promise<string> {
  return new SignJWT({
    boardId: c.boardId,
    orgId: c.orgId ?? "org_1",
    role: c.role ?? "editor",
    name: c.name ?? c.userId,
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(c.userId)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (c.expiresInSec ?? 300))
    .sign(privateKey);
}

export async function signAdminToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  audience = ADMIN_AUDIENCE,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(privateKey);
}

export async function waitFor(check: () => boolean, timeoutMs = 3_000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

let tabCounter = 0;

/** A browser stand-in: real socket + real SyncClient, like BuddySyncProvider will be. */
export class TestClient {
  readonly sync: SyncClient;
  readonly received: TransportServerMessage[] = [];
  readonly others = new Map<string, PresenceEntry>();
  socket!: WebSocket;
  closeCode: number | null = null;
  /** Ask for presence batches, as current browser clients do. Off = an older client. */
  batchPresence = false;

  constructor(
    readonly url: string,
    readonly token: string,
    readonly userId: string,
    readonly tab = `tab${String(++tabCounter).padStart(6, "0")}`,
  ) {
    this.sync = new SyncClient(new Replica(`${userId}~${tab}`), (msg) => this.sendRaw(msg));
  }

  get key(): string {
    return `${this.userId}~${this.tab}`;
  }

  async connect(): Promise<this> {
    this.closeCode = null;
    this.socket = new WebSocket(this.url);
    this.socket.on("message", (data) => this.onMessage(JSON.parse(data.toString())));
    this.socket.on("close", (code) => {
      this.closeCode = code;
      this.sync.onClose();
    });
    await new Promise<void>((resolve, reject) => {
      this.socket.once("open", () => resolve());
      this.socket.once("error", reject);
    });
    this.sync.onOpen();
    return this;
  }

  sendRaw(msg: TransportClientMessage | Record<string, unknown>): void {
    const out =
      (msg as { t: string }).t === "hello"
        ? { ...msg, token: this.token, tab: this.tab, ...(this.batchPresence ? { batchPresence: true } : {}) }
        : msg;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(out));
  }

  presence(data: Record<string, unknown>): void {
    this.sendRaw({ t: "presence", data });
  }

  close(code?: number): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close(code);
    });
  }

  /** Drop the connection without a close handshake, like a lost network. */
  terminate(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.terminate();
    });
  }

  waitForClose(): Promise<number> {
    return waitFor(() => this.closeCode !== null, 3_000, "socket close").then(() => this.closeCode!);
  }

  private onMessage(msg: TransportServerMessage): void {
    this.received.push(msg);
    switch (msg.t) {
      case "presence-state":
        this.others.clear();
        for (const e of msg.others) this.others.set(e.id, e);
        break;
      case "presence-join":
        this.others.set(msg.entry.id, msg.entry);
        break;
      case "presence": {
        const e = this.others.get(msg.id);
        if (e) this.others.set(msg.id, { ...e, data: { ...e.data, ...msg.data } });
        break;
      }
      case "presence-batch":
        for (const { id, data } of msg.updates) {
          const e = id === this.key ? undefined : this.others.get(id);
          if (e) this.others.set(id, { ...e, data: { ...e.data, ...data } });
        }
        break;
      case "presence-leave":
        this.others.delete(msg.id);
        break;
      case "welcome":
      case "ack":
      case "ops":
      case "error":
        this.sync.onMessage(msg);
        break;
    }
  }
}
