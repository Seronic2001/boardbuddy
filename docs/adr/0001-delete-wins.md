# ADR 0001: Delete wins over concurrent edits

- Status: accepted
- Date: 2026-11-12
- Code: `packages/sync-core/src/doc.ts`

## Context

Every layer field is a last-writer-wins register ordered by a hybrid logical clock. We need
a rule for when one user deletes a layer while another user (often offline) edits it.

Option A: `deleted` is an ordinary LWW field, and any later write brings the layer back.
Option B: delete wins. Edits never bring a layer back. Only an explicit restore (undo of the
delete) does.

Both options converge. Under A, a shape someone deleted can come back because a teammate
nudged it while offline, which surprises users.

## Decision

Option B, implemented so that it still converges:

1. Visibility lives only in the reserved `deleted` register. Only `create` (writes `false`),
   `delete` (`true`) and `restore` (`false`) write it, and the newest of those decides. A
   `set` op may not target `deleted`. `assertValidOp` rejects that, and the server must
   reject it too.
2. A `set` on a deleted layer is **still recorded** in its field register. It just isn't
   visible.

Point 2 is what keeps replicas identical. If replicas dropped edits to deleted layers, a
replica that got the edit *before* the delete would keep it, and one that got it *after*
would not. After a restore the two replicas would show different shapes. Recording the edit
everywhere makes the result independent of arrival order.

Consequences:

- Restoring a layer shows the newest value of each field, including edits made while it was
  deleted. That seems right: the teammate's offline nudge isn't lost, it is just invisible
  until someone brings the layer back.
- A `set` that arrives before its `create` (reordering) is also kept. The layer appears once
  the create arrives, and the newer set still wins.
- A layer stays in the document as a tombstone after deletion. Tombstones are removed only
  by compaction, after the maximum offline window. See ADR 0002 for how that stays
  convergent.

## Verification

`test/doc.test.ts` covers this:

- "delete wins" unit tests: a later edit doesn't resurrect; a restore shows the same state
  on replicas that received ops in opposite orders; a create that arrives after a newer
  delete stays deleted.
- A property test checks that visibility equals "the newest create/delete/restore is not a
  delete" for random op sets.
- Convergence property tests include delete and restore ops.
