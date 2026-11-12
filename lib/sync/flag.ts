/**
 * Which real-time backend a board uses. Read on the server per request.
 *
 *   SYNC_BACKEND_BOARDS=*                 every board on BuddySync
 *   SYNC_BACKEND_BOARDS=id1,id2           only these boards
 *   (unset)                               every board on Liveblocks
 *   ?sync=buddysync | ?sync=liveblocks    per-visit override for testing
 *
 * Rolling a board back is a config change, not a deploy of new code. BuddySync needs
 * NEXT_PUBLIC_SYNC_URL and SYNC_PRIVATE_KEY; without them every board stays on Liveblocks.
 */

export type SyncBackendKind = "liveblocks" | "buddysync";

export function resolveSyncBackend(boardId: string, override?: string | string[]): SyncBackendKind {
  const buddySyncConfigured = Boolean(process.env.NEXT_PUBLIC_SYNC_URL && process.env.SYNC_PRIVATE_KEY);
  if (!buddySyncConfigured) return "liveblocks";
  if (override === "buddysync" || override === "liveblocks") return override;
  const boards = (process.env.SYNC_BACKEND_BOARDS ?? "").split(",").map((b) => b.trim());
  return boards.includes("*") || boards.includes(boardId) ? "buddysync" : "liveblocks";
}
