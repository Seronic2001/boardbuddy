# Deploying the BuddySync sync server

The Next.js app stays on Vercel. The sync server is a long-running WebSocket process, so it
runs on **Render** (free web service) from `packages/sync-server/Dockerfile`, configured
by `render.yaml` in the repository root, with **Neon** (free Postgres) for storage. Boards
move over one at a time with `SYNC_BACKEND_BOARDS`.

What the free tiers mean here:

- Render's free service **sleeps after 15 minutes without traffic** and takes about a minute
  to wake. The first person to open a board after a quiet spell sees "Reconnecting…" for
  that minute. Nothing is lost: rooms reload from Postgres, and clients resend anything
  unacknowledged. A paid instance (or any always-on host) removes the wait.
- Render's free workspace includes 5 GB of bandwidth a month, and Neon's free plan 1 GB of
  storage per project. That's plenty for a team whiteboard; check usage if it grows.

**Run one instance.** Rooms live in one process's memory and there is no cross-node room
ownership yet. The free plan runs one instance. Don't scale it up on a paid plan either.
The brief overlap of old and new instance during a deploy is safe: Postgres's
`(board_id, seq)` primary key rejects the second writer of any sequence number, so at worst
a room reloads (see the "two instances on one board" tests in `postgres.test.ts`).

## 1. Postgres (Neon)

Create a free Neon project in the region nearest your Render region (`render.yaml` uses
Singapore, so AWS `ap-southeast-1`). With the Neon CLI:
`neon projects create --name boardbuddy-sync --region-id aws-ap-southeast-1`, then
`neon connection-string --project-id <id>` prints the direct string. Copy the **direct** connection string, not the pooled
one: the sync server keeps its own small pool. It looks like
`postgres://user:password@ep-...ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.

The schema is applied by the container every time it starts, so there is nothing to run
by hand.

## 2. A production key pair

```sh
npx tsx packages/sync-server/scripts/generate-keys.ts > .env.sync-prod.local
```

Make a new pair; don't reuse the one in your local `.env` files. `.env.sync-prod.local` is
ignored by git. The **private** key goes to Vercel (it signs room tokens), the **public**
key to Render (it only verifies them).

## 3. Create the service on Render

The Blueprint deploys from `master`, so merge the BuddySync branch first. That is safe:
every board stays on Liveblocks until step 5.

1. Render dashboard → New → Blueprint → connect the GitHub repository. Render reads
   `render.yaml` and proposes the `boardbuddy-sync` service (free plan).
2. Fill in the three values it asks for:
   - `SYNC_PUBLIC_KEY`: the `SYNC_PUBLIC_KEY` value from `.env.sync-prod.local`, without
     the surrounding quotes and with the literal `\n`s as they are.
   - `DATABASE_URL`: the Neon direct connection string from step 1.
   - `ALLOWED_ORIGINS`: your site's origin, for example `https://boardbuddy.example.com`
     (comma-separate several, such as a preview domain).
3. Apply. The first build takes a few minutes.

## 4. Check it

```sh
curl https://boardbuddy-sync.onrender.com/healthz    # your service's URL from the dashboard
# {"ok":true,"rooms":0,"connections":0}
```

The service log shows `migrations up to date` and then a `listening` event with
`"storage":"postgres"`. Later deploys happen on every push to `master` that touches the
server. On each deploy the old instance gets SIGTERM, saves every room's pending writes,
and closes its sockets. Clients show "Reconnecting…", reconnect to the new version within
seconds, and resend anything that wasn't acknowledged.

## 5. Point the app at it (Vercel)

Set these in the Vercel project and redeploy:

| Variable | Value |
|---|---|
| `SYNC_PRIVATE_KEY` | the private key from step 2 |
| `NEXT_PUBLIC_SYNC_URL` | `wss://boardbuddy-sync.onrender.com` (your service's host) |
| `SYNC_BACKEND_BOARDS` | leave unset for now |

Every board is still on Liveblocks. Open any board with `?sync=buddysync` to check that
BuddySync works in production. A board you haven't migrated will look empty there.

### Disconnecting removed members (Clerk webhook)

Without this step, someone removed from an organization stays connected until their room
token expires (up to 5 minutes). With it, they are disconnected at once.

1. Clerk dashboard → Webhooks → Add endpoint: `https://<your-app>/api/clerk-webhook`.
   Subscribe to `organizationMembership.deleted`, `organization.deleted` and `user.deleted`.
2. Copy the endpoint's signing secret into Vercel as `CLERK_WEBHOOK_SIGNING_SECRET` and
   redeploy.
3. Optional: `SYNC_ADMIN_URL` if the sync server's HTTP address isn't simply
   `NEXT_PUBLIC_SYNC_URL` with `wss://` → `https://`.

The route signs a 60-second admin token with `SYNC_PRIVATE_KEY`, and the sync server checks
it with the public key it already has. No new secret is needed on Render. Check it with
Clerk's "Send example" for `organizationMembership.deleted`: the route should answer
`{"ok":true,"disconnected":0}`, and the Render log shows a `revoke` event.

Revocations are kept in memory on the single sync instance. A restart or wake-up forgets
them, by which time /api/sync-auth refuses the removed member anyway. They also refuse room tokens
issued in the next 90 seconds, because Clerk session tokens can carry the old membership
for about a minute. A member re-added right after removal may have to wait that long.

## 6. Move boards over

```sh
# from your machine, against the production database
DATABASE_URL="postgres://..." npm run sync:migrate-liveblocks -- --all           # dry run
DATABASE_URL="postgres://..." npm run sync:migrate-liveblocks -- --all --write
```

The script needs `LIVEBLOCKS_SECRET` (read from `.env.local`; use the production key).
It never overwrites a board that already has BuddySync data, so it's safe to re-run.
If your network blocks outbound port 5432, add `--neon-websocket`: it reaches Neon through
its serverless driver over WebSockets on port 443, with the same connection string.

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
docker run --rm --network boardbuddy_default -p 8787:8080 \
  -e DATABASE_URL=postgres://buddysync:buddysync@postgres:5432/buddysync \
  -e SYNC_PUBLIC_KEY="$(grep '^SYNC_PUBLIC_KEY=' packages/sync-server/.env | cut -d= -f2- | tr -d '\"')" \
  buddysync
```

The container applies migrations, then listens. With `npm run dev` running, the app and
`npm run test:e2e` then use it.
