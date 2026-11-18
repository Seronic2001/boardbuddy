import type { DocJSON, Op } from "./doc";
import type { HLC } from "./hlc";

/**
 * Wire protocol v1 (JSON). Auth (the room token) is handled by the transport wrapper, so
 * these messages carry only sync state.
 *
 * Sequence numbers:
 *  - `cseq` is per client and increases by one per op. The server accepts a client's ops
 *    only in cseq order and ignores ones it already has, so resending is always safe.
 *  - `seq` is the server's total order for the room. A client's `lastSeq` is the highest
 *    seq it has applied with no gaps before it.
 *
 * Lost history (the server restored from an older backup): a seq alone can't show it, since
 * the restored server may already have reused the client's lastSeq for different ops. So
 * hello also carries the timestamp of the op at lastSeq (`lastTs`, unique per op). If the
 * room has no such op there, it sends a snapshot with `reset`, and the client resyncs and
 * re-sends whatever it has that the server lost. `nextCseq` lets the room skip the cseqs it
 * forgot, so the client's new ops aren't stuck behind a gap.
 */

export type PendingOp = { readonly cseq: number; readonly op: Op };

export type ClientMessage =
  /** Sent on every (re)connect and periodically as a resync heartbeat. */
  | {
      readonly t: "hello";
      readonly lastSeq: number;
      readonly pending: readonly PendingOp[];
      /** Timestamp of the op at lastSeq, if the client knows it. */
      readonly lastTs?: HLC;
      /** The cseq this client will use next. */
      readonly nextCseq?: number;
    }
  | { readonly t: "ops"; readonly batch: readonly PendingOp[] };

export type Snapshot = {
  readonly seq: number;
  readonly doc: DocJSON;
  /** Highest accepted cseq per client, so dedup survives log compaction. */
  readonly cseqs: Readonly<Record<string, number>>;
  /** Timestamp of the op at `seq`, so a client's lastSeq can be checked against it. */
  readonly headTs?: HLC;
};

export type ServerMessage =
  | {
      readonly t: "welcome";
      readonly seq: number;
      readonly catchup:
        | { readonly kind: "ops"; readonly from: number; readonly ops: readonly Op[] }
        | {
            readonly kind: "snapshot";
            readonly snapshot: Snapshot;
            /** The room's history doesn't contain the client's lastSeq (see top of file). */
            readonly reset?: boolean;
          };
    }
  /** Every op of this client up to `upTo` is durable. */
  | { readonly t: "ack"; readonly upTo: number; readonly seq: number }
  /** Committed ops; `batch[i]` has seq `seq + i`. Echoed to the author too. */
  | { readonly t: "ops"; readonly seq: number; readonly batch: readonly Op[] }
  | { readonly t: "error"; readonly code: "INVALID_OP"; readonly cseq: number; readonly message: string };

// ---------------------------------------------------------------------------------------
// Transport layer (WebSocket). Wraps the sync messages above with auth and presence.
// ---------------------------------------------------------------------------------------

export type PresenceData = { readonly [key: string]: unknown };

export type PresenceUser = {
  readonly userId: string;
  readonly name: string;
  readonly picture?: string;
};

export type PresenceEntry = {
  /** Connection key `${userId}~${tabId}`, stable across reconnects of the same tab. */
  readonly id: string;
  readonly user: PresenceUser;
  readonly data: PresenceData;
};

export type TransportClientMessage =
  /**
   * First message on a socket must carry `token` and `tab`. Later hellos are resync
   * heartbeats; their token is ignored.
   */
  | {
      readonly t: "hello";
      readonly token?: string;
      readonly tab?: string;
      readonly lastSeq: number;
      readonly pending: readonly PendingOp[];
      readonly lastTs?: HLC;
      readonly nextCseq?: number;
      /** The client understands `presence-batch`. Older clients get one `presence` per update. */
      readonly batchPresence?: boolean;
    }
  | { readonly t: "ops"; readonly batch: readonly PendingOp[] }
  /** Partial update, merged into this connection's presence. */
  | { readonly t: "presence"; readonly data: PresenceData }
  /** Fresh token before the current one expires. */
  | { readonly t: "reauth"; readonly token: string };

export type FatalCode =
  | "UNAUTHORIZED"
  | "TOKEN_EXPIRED"
  | "BAD_MESSAGE"
  | "ROOM_UNAVAILABLE"
  | "REPLACED";

export type TransportServerMessage =
  | ServerMessage
  /** Sent once after a successful first hello. `self` is the id ops must be authored with. */
  | { readonly t: "presence-state"; readonly self: string; readonly others: readonly PresenceEntry[] }
  | { readonly t: "presence-join"; readonly entry: PresenceEntry }
  | { readonly t: "presence"; readonly id: string; readonly data: PresenceData }
  /**
   * Every presence change in the room since the last batch, at most one batch per presence
   * interval. The same message goes to everyone, so it may include the recipient's own id:
   * skip it.
   */
  | { readonly t: "presence-batch"; readonly updates: readonly { readonly id: string; readonly data: PresenceData }[] }
  | { readonly t: "presence-leave"; readonly id: string }
  | { readonly t: "read-only"; readonly cseq: number }
  /** The server closes the socket right after this. */
  | { readonly t: "fatal"; readonly code: FatalCode; readonly message: string };

/** Close codes used by the sync server (4000–4999 are application-defined). */
export const CloseCode = {
  Unauthorized: 4001,
  TokenExpired: 4002,
  BadMessage: 4003,
  RoomUnavailable: 4004,
  Replaced: 4005,
} as const;
