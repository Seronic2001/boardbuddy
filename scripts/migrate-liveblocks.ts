/**
 * Copies boards from Liveblocks room storage into BuddySync's Postgres.
 *
 *   npm run sync:migrate-liveblocks -- --all                 dry run over every Liveblocks room
 *   npm run sync:migrate-liveblocks -- <boardId> <boardId>   dry run for some boards
 *   npm run sync:migrate-liveblocks -- --all --write         actually write
 *
 * Needs LIVEBLOCKS_SECRET (read from .env.local) and DATABASE_URL (BuddySync's Postgres;
 * set it in the environment or .env.local). Without --write nothing is written anywhere.
 *
 * Safe to re-run: boards that already have BuddySync data are skipped. Migrate a board
 * before its flag points at BuddySync (SYNC_BACKEND_BOARDS); see lib/sync/migrate-liveblocks.ts.
 */
import { MemoryPersister, PostgresPersister } from "@boardbuddy/sync-server";

import { migrateBoard, type BoardResult, type MigrationTarget } from "@/lib/sync/migrate-liveblocks";

const API = "https://api.liveblocks.io/v2";

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error("Usage: npm run sync:migrate-liveblocks -- (--all | <boardId>...) [--write]");
  process.exit(1);
}

async function liveblocks(secret: string, path: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${secret}` } });
    if (res.status !== 429 || attempt === 4) return res;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // rate limited
  }
}

async function listRooms(secret: string): Promise<string[]> {
  const ids: string[] = [];
  let path: string | null = "/rooms?limit=100";
  while (path) {
    const res = await liveblocks(secret, path);
    if (!res.ok) throw new Error(`listing rooms failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data: { id: string }[]; nextPage?: string | null; nextCursor?: string | null };
    ids.push(...body.data.map((room) => room.id));
    path = body.nextPage
      ? body.nextPage.replace(/^\/v2/, "")
      : body.nextCursor
        ? `/rooms?limit=100&startingAfter=${encodeURIComponent(body.nextCursor)}`
        : null;
  }
  return ids;
}

function storageFetcher(secret: string) {
  return async (boardId: string): Promise<unknown | null> => {
    const res = await liveblocks(secret, `/rooms/${encodeURIComponent(boardId)}/storage?format=json`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Liveblocks storage: ${res.status} ${await res.text()}`);
    return res.json();
  };
}

function describe(r: BoardResult): string {
  switch (r.status) {
    case "migrated":
    case "would-migrate": {
      const verb = r.status === "migrated" ? "migrated" : "would migrate";
      return [`${verb} (${r.layers} layers)`, ...r.warnings.map((w) => `  warning: ${w}`)].join("\n");
    }
    case "skipped":
      return `skipped: ${r.reason}`;
    case "failed":
      return `FAILED: ${r.error}`;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const all = args.includes("--all");
  const ids = args.filter((a) => !a.startsWith("--"));
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--write" && a !== "--all");
  if (unknown.length) usage(`unknown option ${unknown.join(", ")}`);
  if (all === ids.length > 0) usage("pass either --all or board ids");

  const secret = process.env.LIVEBLOCKS_SECRET;
  if (!secret) usage("LIVEBLOCKS_SECRET is not set");

  let target: MigrationTarget & { close(): Promise<void> };
  if (process.env.DATABASE_URL) {
    target = new PostgresPersister(process.env.DATABASE_URL);
  } else if (!write) {
    console.warn("DATABASE_URL is not set: dry run without checking for existing BuddySync data.\n");
    target = new MemoryPersister();
  } else {
    usage("DATABASE_URL is required with --write");
  }

  try {
    const boards = all ? await listRooms(secret) : ids;
    console.log(`${write ? "Migrating" : "Dry run:"} ${boards.length} board(s)\n`);

    const fetchStorage = storageFetcher(secret);
    const counts: Record<BoardResult["status"], number> = { migrated: 0, "would-migrate": 0, skipped: 0, failed: 0 };
    for (const boardId of boards) {
      const result = await migrateBoard(boardId, { fetchStorage, target, dryRun: !write });
      counts[result.status]++;
      console.log(`${boardId}: ${describe(result)}`);
    }

    console.log(
      `\n${write ? `${counts.migrated} migrated` : `${counts["would-migrate"]} would be migrated`}, ` +
        `${counts.skipped} skipped, ${counts.failed} failed.`,
    );
    if (!write && counts["would-migrate"] > 0) console.log("Run again with --write to migrate.");
    if (counts.failed > 0) process.exitCode = 1;
  } finally {
    await target.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
