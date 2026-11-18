import { AuthRejectedError, type AuthResult } from "@boardbuddy/sync-client";

export type Authenticate = (boardId: string) => Promise<AuthResult>;

async function requestToken(url: string, body: object): Promise<AuthResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // 404 too: the test-only route answers 404 when it's disabled, which won't change on retry.
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new AuthRejectedError();
  if (!res.ok) throw new Error(`sync-auth failed with ${res.status}`);
  return (await res.json()) as AuthResult;
}

/** Room token from the Next.js route. 401/403 are final; anything else is retried. */
export function fetchSyncToken(boardId: string): Promise<AuthResult> {
  return requestToken("/api/sync-auth", { room: boardId });
}

/** Test-only: room tokens for a made-up user (see lib/e2e.ts). */
export function e2eTokenFetcher(user: string): Authenticate {
  return (boardId) => requestToken("/api/e2e/sync-auth", { room: boardId, user });
}
