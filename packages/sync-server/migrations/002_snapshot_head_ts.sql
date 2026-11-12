-- Timestamp of the op at a snapshot's seq. After a restart the room still knows which op
-- sits at its head, so a client that saw a different history (the database was restored
-- from an older backup) is detected and resynced instead of silently skipping ops.
-- Null for snapshots written before this column existed.
alter table board_snapshots add column if not exists head_ts jsonb;
