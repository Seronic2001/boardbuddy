# BoardBuddy

Real-time collaborative whiteboards for teams. Create boards inside an organization, invite teammates, and draw together with live cursors and selections.

## Features

- **Organizations** — boards belong to a Clerk organization; only its members can see, open or change them
- **Dashboard** — create, rename, delete, search and favorite boards
- **Canvas** — rectangles, ellipses, text, sticky notes and freehand pen
- **Editing** — move, resize, recolor, bring to front / send to back, multi-select with a selection net
- **Collaboration** — live cursors, live selections and in-progress pen strokes from everyone on the board
- **History** — undo and redo

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` | Redo |
| `Delete` / `Backspace` | Delete selected layers |

Shortcuts are ignored while typing in a note, text layer or input.

## Tech stack

| Area | Tool |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Auth and organizations | Clerk |
| Database (boards, favorites) | Convex |
| Canvas storage and presence | Liveblocks |
| UI | Tailwind CSS, shadcn/ui (Radix), lucide-react |
| State | Zustand |

## Getting started

Requires Node.js 20.9 or newer, plus Clerk, Convex and Liveblocks accounts.

```bash
npm install
npx convex dev   # terminal 1: links the Convex project and watches convex/
npm run dev      # terminal 2: http://localhost:3000
```

### Environment variables

Create `.env.local` in the project root:

| Variable | Used for |
| --- | --- |
| `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL` | Convex deployment (written by `npx convex dev`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk |
| `LIVEBLOCKS_SECRET` | Liveblocks secret key, used by `/api/liveblocks-auth` |

### Clerk setup

1. Enable **Organizations** in the Clerk dashboard.
2. Create a JWT template named `convex` that includes the active organization:

   ```json
   {
     "org_id": "{{org.id}}"
   }
   ```

   Convex authorizes every board operation against this claim. Without it, every query and mutation fails with `Unauthorized`.
3. Set the Clerk issuer domain in `convex/auth.config.js`.

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Start the Next.js dev server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | Run ESLint |

## Project structure

```
app/
  (dashboard)/        board list, search, favorites, org sidebar
  board/[boardId]/    the canvas and its tools
  api/liveblocks-auth Liveblocks room authorization
components/           shared UI, modals, shadcn/ui primitives
convex/               schema, board queries and mutations, org authorization
hooks/, store/, lib/  client hooks, Zustand store, canvas utilities
liveblocks.config.ts  Liveblocks client, presence and storage types
proxy.ts              Clerk route protection
```

## Deployment

Deploy the Convex functions and the Next.js app together, since the frontend depends on the current function signatures:

```bash
npx convex deploy   # push functions and schema to the production deployment
```

Then deploy the app (for example on Vercel) with the environment variables above set to their production values.

## Limits

- A board holds at most 100 layers.
- Deleting a board removes it from Convex; its Liveblocks room is left in place but can no longer be opened.
