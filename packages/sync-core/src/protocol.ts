import type { DocJSON, Op } from "./doc";

/**
 * Wire protocol v1 (JSON). Auth (the room token) is handled by the transport wrapper, so
 * these messages carry only sync state.
 *
 * Sequence numbers:
 *  - `cseq` is per client and increases by one per op. The server accepts a client's ops
 *    only in cseq order and ignores ones it already has, so resending is always safe.
 *  - `seq` is the server's total order for the room. A client's `lastSeq` is the highest
 *    seq it has applied with no gaps before it.
 */

export type PendingOp = { readonly cseq: number; readonly op: Op };

export type ClientMessage =
  /** Sent on every (re)connect and periodically as a resync heartbeat. */
  | { readonly t: "hello"; readonly lastSeq: number; readonly pending: readonly PendingOp[] }
  | { readonly t: "ops"; readonly batch: readonly PendingOp[] };

export type Snapshot = {
  readonly seq: number;
  readonly doc: DocJSON;
  /** Highest accepted cseq per client, so dedup survives log compaction. */
  readonly cseqs: Readonly<Record<string, number>>;
};

export type ServerMessage =
  | {
      readonly t: "welcome";
      readonly seq: number;
      readonly catchup:
        | { readonly kind: "ops"; readonly from: number; readonly ops: readonly Op[] }
        | { readonly kind: "snapshot"; readonly snapshot: Snapshot };
    }
  /** Every op of this client up to `upTo` is durable. */
  | { readonly t: "ack"; readonly upTo: number; readonly seq: number }
  /** Committed ops; `batch[i]` has seq `seq + i`. Echoed to the author too. */
  | { readonly t: "ops"; readonly seq: number; readonly batch: readonly Op[] }
  | { readonly t: "error"; readonly code: "INVALID_OP"; readonly cseq: number; readonly message: string };
