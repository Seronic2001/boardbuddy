/**
 * Test-only sign-in bypass for end-to-end tests (Playwright).
 *
 * /e2e/board/<id> renders the real canvas on BuddySync, and /api/e2e/sync-auth issues room
 * tokens for made-up users without Clerk or Convex. Both answer 404 unless:
 *   - E2E_TEST_AUTH=1, and
 *   - NODE_ENV is not "production" (so `next build` / Vercel deploys can never enable it).
 *
 * Even when enabled, only board ids starting with "e2e-" are accepted. Real boards have
 * Convex ids, which never look like that, so test tokens can't open a real board.
 */

export const E2E_ORG_ID = "e2e";

const BOARD_ID = /^e2e-[A-Za-z0-9_-]{1,60}$/;
const USER = /^[A-Za-z0-9_-]{1,32}$/;

type Env = Record<string, string | undefined>;

export function isE2eEnabled(env: Env = process.env): boolean {
  return env.E2E_TEST_AUTH === "1" && env.NODE_ENV !== "production";
}

export function isE2eBoardId(boardId: unknown): boardId is string {
  return typeof boardId === "string" && BOARD_ID.test(boardId);
}

export type E2eTokenRequest = {
  boardId: string;
  user: string;
  role: "editor" | "viewer";
};

/** Validates the JSON body of POST /api/e2e/sync-auth. Returns null if it's not acceptable. */
export function parseE2eTokenRequest(body: unknown): E2eTokenRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const { room, user, role = "editor" } = body as Record<string, unknown>;
  if (!isE2eBoardId(room)) return null;
  if (typeof user !== "string" || !USER.test(user)) return null;
  if (role !== "editor" && role !== "viewer") return null;
  return { boardId: room, user, role };
}

/** The sync user id for a test user; prefixed so it can't collide with a Clerk user id. */
export function e2eUserId(user: string): string {
  return `e2e_${user}`;
}
