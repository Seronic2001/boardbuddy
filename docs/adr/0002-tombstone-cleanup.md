# ADR 0002: Tombstone cleanup by sequenced purge ops

- Status: accepted
- Date: 2026-11-18
- Code: `packages/sync-core/src/room.ts`, `doc.ts`, `client.ts`; `packages/sync-server/src/room-host.ts`

## Context

Under ADR 0001 a deleted layer stays in the document as a tombstone, so it can still absorb
late edits and come back on undo. Without cleanup, every board grows forever. The plan
(section 5) says to remove tombstones after the maximum offline window (30 days). A client
offline longer than that gets a full snapshot, and its ops on removed layers are dropped and
reported.

Removing data breaks the CRDT argument: "same set of ops → same state" assumes nothing is
ever forgotten. Three things can go wrong:

1. **Late edit after removal.** An op on a removed layer, applied by `apply`, creates a stray
   record holding just that field (or, for a `restore`, a visible empty layer).
2. **Replicas disagree on what was removed.** If each replica purged on its own clock, they
   would purge at different points and diverge.
3. **Merging brings it back.** Snapshots are folded in with `mergeDocs`, which never removes
   layers. A client that still holds the layer keeps it, and a stale snapshot built before
   the purge puts it back on a client that already purged it.

## Decision

1. **Only the server purges, and the purge is an op in the log.** When a snapshot is due
   (every 500 ops, or when an idle room unloads), the room finds deleted layers whose newest
   write to any field is older than `now - 30 days`. It appends one `purge` op per layer,
   authored by `~server`, to the batch. The snapshot is taken after them. Purges get
   sequence numbers, are durable before they are broadcast, and reach every client in the
   same order as every other op. A client inside the catch-up window applies them like any
   op. `apply(purge)` removes the record.
2. **The room rejects ops on layers it doesn't have.** Any non-create op whose layer doesn't
   exist in committed state plus accepted-but-unwritten ops is rejected with `LAYER_GONE`.
   As with every rejection, its cseq is still used up. Every layer a client can see was
   created through the room, so an unknown layer means it was purged (or its create was
   rejected, e.g. by the layer cap). Clients can never send `purge` themselves.
3. **A client that falls back to a snapshot drops what the snapshot lacks.** This applies
   when the welcome snapshot is at or past the client's `lastSeq`. The client drops local
   layers missing from it, except layers created by its own pending ops that the server
   hasn't written yet (cseq above the client's durable cseq in the snapshot). A create the
   server did write, whose ack was lost, and that was later purged must go too. A snapshot
   behind `lastSeq` (an answer to an old heartbeat) holds nothing new, so it is now ignored
   instead of merged. This is what stops case 3.

## Consequences

- An edit made while offline for more than 30 days, on a layer someone deleted more than
  30 days earlier, is lost and reported as `LAYER_GONE`. That includes an offline undo of
  the delete. This is the trade-off the plan accepted.
- Writing to a deleted layer (a late offline nudge) refreshes its tombstone, so the
  30 days count from the last write, not from the delete.
- `purge` is not commutative with later edits to the same layer. Convergence instead rests
  on the server's total order plus rule 2: in seq order, nothing follows a purge on that
  layer except a rejected op.
- After a backup restore (`reset`), a client re-sends visible layers the server lacks. A
  layer purged after that backup was taken could come back this way. That needs a restore
  from backup *and* a 30-day-old tombstone, so it is left open.

## Verification

- `packages/sync-core/test/tombstones.test.ts`: which tombstones expire, purge at snapshot
  and idle compaction, `LAYER_GONE` rejection (including against ops still in flight),
  restart, a client following the log, a client back after the window, and the
  stale-snapshot and lost-ack cases. Both of those tests fail without the matching part
  of rule 3.
- The simulator runs with a 5 s TTL, so purges race with offline clients that keep
  editing, undoing and restoring. Its oracle is "apply every generated op, minus purged
  layers". It found both client-side bugs fixed in rule 3: merging stale snapshots (46 of
  300 seeds diverged) and keeping an already-written own create (2 of the next 700 seeds;
  saved as regression seeds 312 and 996). With both fixed, seeds 1–1,000 converge (9.9M
  ops, 4,277 server crashes, 312,513 purges, 15,461 late ops rejected), as do 50 seeds
  with 40% drops and 50% reordering.
- `packages/sync-server/test/server.test.ts`: an idle room unloads and purges an expired
  tombstone from its snapshot.
