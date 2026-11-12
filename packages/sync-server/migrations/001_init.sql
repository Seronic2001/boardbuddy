-- BuddySync storage. One row per sequenced op, one snapshot per board, and the per-client
-- cseq high-water marks that make resends idempotent (kept outside board_ops so they
-- survive log compaction).

create table if not exists board_ops (
  board_id  text   not null,
  seq       bigint not null,
  client_id text   not null,
  cseq      bigint not null,
  op        jsonb  not null,
  primary key (board_id, seq),
  unique (board_id, client_id, cseq)
);

create table if not exists board_snapshots (
  board_id text   primary key,
  seq      bigint not null,
  state    jsonb  not null,
  cseqs    jsonb  not null
);

create table if not exists board_client_cseqs (
  board_id  text   not null,
  client_id text   not null,
  cseq      bigint not null,
  primary key (board_id, client_id)
);

create table if not exists schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
