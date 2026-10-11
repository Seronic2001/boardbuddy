# BoardBuddy

Real-time collaborative whiteboards for teams, built with Next.js, Clerk (auth and organizations), Convex (boards and favorites) and Liveblocks (canvas storage and presence).

## Setup

```bash
npm install
npx convex dev   # in one terminal
npm run dev      # in another
```

Environment variables (`.env.local`):

| Variable | Used for |
| --- | --- |
| `NEXT_PUBLIC_CONVEX_URL` | Convex deployment URL (written by `npx convex dev`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk |
| `LIVEBLOCKS_SECRET` | Liveblocks secret key, used by `/api/liveblocks-auth` |

### Clerk JWT template

Convex authorizes every board operation against the caller's active organization, which it reads from the `org_id` claim of the Clerk JWT template named `convex`. The template must include:

```json
{
  "org_id": "{{org.id}}"
}
```

Without this claim every Convex query and mutation fails with `Unauthorized`.

The Clerk issuer domain is configured in `convex/auth.config.js`.
