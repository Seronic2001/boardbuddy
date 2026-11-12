import pg from "pg";
import type { DocJSON, DurableState, LogEntry, Op, PersistBatch, Snapshot } from "@boardbuddy/sync-core";
import type { Persister } from "./persister";

/**
 * Postgres storage (Repository for the op log and snapshots). Each batch is one
 * transaction, so a crash mid-write leaves nothing behind, and the room never acks
 * anything that isn't committed.
 */
export class PostgresPersister implements Persister {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, options: { max?: number } = {}) {
    this.pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  }

  async load(boardId: string): Promise<DurableState> {
    const client = await this.pool.connect();
    try {
      // Read in one snapshot-isolated transaction so the log and snapshot agree.
      await client.query("begin isolation level repeatable read read only");
      const snap = await client.query<{ seq: string; state: DocJSON; cseqs: Record<string, number> }>(
        "select seq, state, cseqs from board_snapshots where board_id = $1",
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
        ? { seq: fromSeq, doc: snapshotRow.state, cseqs: snapshotRow.cseqs }
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
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      if (batch.entries.length > 0) {
        await client.query(
          `insert into board_ops (board_id, seq, client_id, cseq, op)
           select $1, x.seq, x.client_id, x.cseq, x.op
           from jsonb_to_recordset($2::jsonb) as x(seq bigint, client_id text, cseq bigint, op jsonb)`,
          [
            boardId,
            JSON.stringify(
              batch.entries.map((e) => ({ seq: e.seq, client_id: e.client, cseq: e.cseq, op: e.op })),
            ),
          ],
        );
      }
      const cseqs = Object.entries(batch.cseqs);
      if (cseqs.length > 0) {
        await client.query(
          `insert into board_client_cseqs (board_id, client_id, cseq)
           select $1, x.client_id, x.cseq
           from jsonb_to_recordset($2::jsonb) as x(client_id text, cseq bigint)
           on conflict (board_id, client_id)
           do update set cseq = greatest(board_client_cseqs.cseq, excluded.cseq)`,
          [boardId, JSON.stringify(cseqs.map(([client_id, cseq]) => ({ client_id, cseq })))],
        );
      }
      if (batch.snapshot) {
        const { seq, doc, cseqs: snapCseqs } = batch.snapshot;
        await client.query(
          `insert into board_snapshots (board_id, seq, state, cseqs) values ($1, $2, $3, $4)
           on conflict (board_id) do update set seq = excluded.seq, state = excluded.state, cseqs = excluded.cseqs
           where board_snapshots.seq < excluded.seq`,
          [boardId, seq, JSON.stringify(doc), JSON.stringify(snapCseqs)],
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
