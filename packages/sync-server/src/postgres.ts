import pg from "pg";
import type { DocJSON, DurableState, HLC, LogEntry, Op, PersistBatch, Snapshot } from "@boardbuddy/sync-core";
import type { BoardBatch, Persister } from "./persister";

/** The slice of pg's Pool this persister uses, so drop-in drivers (Neon's) fit too. */
export interface SqlPool {
  connect(): Promise<{
    query<R extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
    release(): void;
  }>;
  end(): Promise<void>;
}

/**
 * Postgres storage (Repository for the op log and snapshots). Each batch is one
 * transaction, so a crash mid-write leaves nothing behind, and the room never acks
 * anything that isn't committed.
 */
export class PostgresPersister implements Persister {
  private readonly pool: SqlPool;

  /**
   * Takes a connection string, or a ready pool with pg's API (for example Neon's
   * serverless driver, which tunnels over WebSockets on port 443).
   */
  constructor(connection: string | SqlPool, options: { max?: number } = {}) {
    this.pool =
      typeof connection === "string"
        ? new pg.Pool({ connectionString: connection, max: options.max ?? 10 })
        : connection;
  }

  async load(boardId: string): Promise<DurableState> {
    const client = await this.pool.connect();
    try {
      // Read in one snapshot-isolated transaction so the log and snapshot agree.
      await client.query("begin isolation level repeatable read read only");
      const snap = await client.query<{
        seq: string;
        state: DocJSON;
        cseqs: Record<string, number>;
        head_ts: HLC | null;
      }>(
        "select seq, state, cseqs, head_ts from board_snapshots where board_id = $1",
        [boardId],
      );
      const snapshotRow = snap.rows[0];
      const fromSeq = snapshotRow ? Number(snapshotRow.seq) : 0;
      const ops = await client.query<{ seq: string; client_id: string; cseq: string; op: Op }>(
        "select seq, client_id, cseq, op from board_ops where board_id = $1 and seq > $2 order by seq",
        [boardId, fromSeq],
      );
      const cseqRows = await client.query<{ client_id: string; cseq: string }>(
        "select client_id, cseq from board_client_cseqs where board_id = $1",
        [boardId],
      );
      await client.query("commit");

      const entries: LogEntry[] = ops.rows.map((r) => ({
        seq: Number(r.seq),
        client: r.client_id,
        cseq: Number(r.cseq),
        op: r.op,
      }));
      const cseqs = Object.fromEntries(cseqRows.rows.map((r) => [r.client_id, Number(r.cseq)]));
      const snapshot: Snapshot | undefined = snapshotRow
        ? {
            seq: fromSeq,
            doc: snapshotRow.state,
            cseqs: snapshotRow.cseqs,
            ...(snapshotRow.head_ts ? { headTs: snapshotRow.head_ts } : {}),
          }
        : undefined;
      return snapshot ? { snapshot, entries, cseqs } : { entries, cseqs };
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async write(boardId: string, batch: PersistBatch): Promise<void> {
    await this.writeMany([{ boardId, batch }]);
  }

  /**
   * Writes several boards' batches in one transaction: all of them become durable, or none
   * do. Each board may appear at most once (a room has one write in flight at a time).
   */
  async writeMany(items: readonly BoardBatch[]): Promise<void> {
    if (new Set(items.map((i) => i.boardId)).size !== items.length) {
      throw new Error("writeMany: a board appears twice in one transaction");
    }
    const ops = items.flatMap(({ boardId, batch }) =>
      batch.entries.map((e) => ({ board_id: boardId, seq: e.seq, client_id: e.client, cseq: e.cseq, op: e.op })),
    );
    const cseqs = items.flatMap(({ boardId, batch }) =>
      Object.entries(batch.cseqs).map(([client_id, cseq]) => ({ board_id: boardId, client_id, cseq })),
    );
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (ops.length > 0) {
        await client.query(
          `insert into board_ops (board_id, seq, client_id, cseq, op)
           select x.board_id, x.seq, x.client_id, x.cseq, x.op
           from jsonb_to_recordset($1::jsonb) as x(board_id text, seq bigint, client_id text, cseq bigint, op jsonb)`,
          [JSON.stringify(ops)],
        );
      }
      if (cseqs.length > 0) {
        await client.query(
          `insert into board_client_cseqs (board_id, client_id, cseq)
           select x.board_id, x.client_id, x.cseq
           from jsonb_to_recordset($1::jsonb) as x(board_id text, client_id text, cseq bigint)
           on conflict (board_id, client_id)
           do update set cseq = greatest(board_client_cseqs.cseq, excluded.cseq)`,
          [JSON.stringify(cseqs)],
        );
      }
      for (const { boardId, batch } of items) {
        if (!batch.snapshot) continue;
        const { seq, doc, cseqs: snapCseqs, headTs } = batch.snapshot;
        await client.query(
          `insert into board_snapshots (board_id, seq, state, cseqs, head_ts) values ($1, $2, $3, $4, $5)
           on conflict (board_id) do update
             set seq = excluded.seq, state = excluded.state, cseqs = excluded.cseqs, head_ts = excluded.head_ts
           where board_snapshots.seq < excluded.seq`,
          [boardId, seq, JSON.stringify(doc), JSON.stringify(snapCseqs), headTs ? JSON.stringify(headTs) : null],
        );
        // Compaction: everything up to the snapshot is now redundant.
        await client.query("delete from board_ops where board_id = $1 and seq <= $2", [boardId, seq]);
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
