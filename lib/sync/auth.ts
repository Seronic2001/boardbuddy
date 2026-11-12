import { AuthRejectedError, type AuthResult } from "@boardbuddy/sync-client";

/** Room token from the Next.js route. 401/403 are final; anything else is retried. */
export async function fetchSyncToken(boardId: string): Promise<AuthResult> {
  const res = await fetch("/api/sync-auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ room: boardId }),
  });
  if (res.status === 401 || res.status === 403) throw new AuthRejectedError();
  if (!res.ok) throw new Error(`sync-auth failed with ${res.status}`);
  return (await res.json()) as AuthResult;
}
