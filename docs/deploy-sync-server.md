# Deploying the BuddySync sync server

The Next.js app stays on Vercel. The sync server is a long-running WebSocket process, so it
runs on Fly.io from `packages/sync-server/Dockerfile`, configured by `fly.toml` in the
repository root. Boards move over one at a time with `SYNC_BACKEND_BOARDS`.

**Run exactly one machine.** Rooms live in one process's memory and there is no
cross-node room ownership yet, so two machines would corrupt boards. Always deploy with
`--ha=false`, and never use the bluegreen or canary strategies.

## 1. Postgres

Any Postgres 14+ works (Fly Managed Postgres, Neon, Supabase...). Note its connection
string, with `?sslmode=require` if the provider needs TLS. The schema is applied on every
deploy by the release command, so there is nothing to run by hand.

## 2. A production key pair

```sh
npm run sync:keys
```

Make a new pair; don't reuse the one in your local `.env` files. The **private** key goes
to Vercel (it signs room tokens), the **public** key to Fly (it only verifies them).

## 3. Create the app and set secrets

Install `flyctl` and run `fly auth login`. Then, from the repository root:

```sh
fly apps create boardbuddy-sync         # or another name; update `app` in fly.toml to match
fly secrets set --stage \
  SYNC_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----" \
  DATABASE_URL="postgres://..."
```

Set `ALLOWED_ORIGINS` in `fly.toml` to your site's origin (for example
`https://boardbuddy.example.com`).

## 4. Deploy

```sh
fly deploy --ha=false
fly scale count 1 --yes                 # make sure it's one machine
curl https://boardbuddy-sync.fly.dev/healthz
# {"ok":true,"rooms":0,"connections":0}
```

Later deploys are just `fly deploy --ha=false`. On each deploy the old machine gets
SIGTERM, saves every room's pending writes, and closes its sockets. Clients show
"Reconnecting…", reconnect to the new version within seconds, and resend anything that
wasn't acknowledged, so no edits are lost.

## 5. Point the app at it (Vercel)

Set these in the Vercel project and redeploy:

| Variable | Value |
|---|---|
| `SYNC_PRIVATE_KEY` | the private key from step 2 |
| `NEXT_PUBLIC_SYNC_URL` | `wss://boardbuddy-sync.fly.dev` |
| `SYNC_BACKEND_BOARDS` | leave unset for now |

Every board is still on Liveblocks. Open any board with `?sync=buddysync` to check that
BuddySync works in production. A board you haven't migrated will look empty there.

## 6. Move boards over

```sh
# from your machine, against the production database
DATABASE_URL="postgres://..." npm run sync:migrate-liveblocks -- --all           # dry run
DATABASE_URL="postgres://..." npm run sync:migrate-liveblocks -- --all --write
```

The script needs `LIVEBLOCKS_SECRET` (read from `.env.local`; use the production key).
It never overwrites a board that already has BuddySync data, so it's safe to re-run.

Then switch boards in Vercel, redeploying after each change:

1. `SYNC_BACKEND_BOARDS=<one board id>`: try it with real use.
2. `SYNC_BACKEND_BOARDS=*`: every board.

Migrate a board **before** it's switched. Run the script again right before switching, to
pick up boards created or edited on Liveblocks since the last run. Boards already on
BuddySync are skipped, so a board edited on Liveblocks after its migration keeps its
migrated version. To start that board over, delete its rows from the `board_*` tables
before re-running.

### Rolling back

Unset `SYNC_BACKEND_BOARDS` (or remove an id) and redeploy: those boards are back on
Liveblocks. Edits made on BuddySync are **not** copied back, so roll back early rather than
late.

## Testing the image locally

```sh
docker compose up -d                    # Postgres on localhost:5433
docker build -f packages/sync-server/Dockerfile -t buddysync .
docker run --rm --network boardbuddy_default \
  -e DATABASE_URL=postgres://buddysync:buddysync@postgres:5432/buddysync \
  buddysync node dist/migrate.mjs
docker run --rm --network boardbuddy_default -p 8787:8080 \
  -e DATABASE_URL=postgres://buddysync:buddysync@postgres:5432/buddysync \
  -e SYNC_PUBLIC_KEY="$(grep '^SYNC_PUBLIC_KEY=' packages/sync-server/.env | cut -d= -f2- | tr -d '\"')" \
  buddysync
```

With `npm run dev` running, the app and `npm run test:e2e` then use the container.
