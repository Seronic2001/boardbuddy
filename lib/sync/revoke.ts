import type { WebhookEvent } from "@clerk/nextjs/webhooks";
import { signAdminToken } from "./token";

// Server-only. When someone loses access in Clerk, tell the sync server to close their
// sockets at once instead of waiting up to 5 minutes for their room token to expire.

export type Revocation = { orgId?: string; userId?: string };

/** Which access a Clerk event takes away, or null if it takes none away. */
export function revocationFor(evt: WebhookEvent): Revocation | null {
  switch (evt.type) {
    case "organizationMembership.deleted":
      return { orgId: evt.data.organization.id, userId: evt.data.public_user_data.user_id };
    case "organization.deleted":
      return evt.data.id ? { orgId: evt.data.id } : null;
    case "user.deleted":
      return evt.data.id ? { userId: evt.data.id } : null;
    default:
      return null;
  }
}

/** The sync server's HTTP base URL. SYNC_ADMIN_URL wins; otherwise wss:// → https://. */
export function syncAdminUrl(env: { SYNC_ADMIN_URL?: string; NEXT_PUBLIC_SYNC_URL?: string }): string | null {
  const base = env.SYNC_ADMIN_URL || env.NEXT_PUBLIC_SYNC_URL?.replace(/^ws(s?):\/\//, "http$1://");
  return base ? base.replace(/\/+$/, "") : null;
}

export async function revokeSyncAccess(
  revocation: Revocation,
  config: { privateKey: string; adminUrl: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<{ disconnected: number }> {
  const token = await signAdminToken({ action: "revoke", ...revocation }, config.privateKey);
  const res = await (config.fetch ?? fetch)(`${config.adminUrl}/admin/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    // A sleeping free-tier sync server takes several seconds (up to about a minute) to wake.
    signal: AbortSignal.timeout(config.timeoutMs ?? 50_000),
  });
  if (!res.ok) throw new Error(`Sync server refused the revocation: HTTP ${res.status}`);
  const body = (await res.json()) as { disconnected?: number };
  return { disconnected: body.disconnected ?? 0 };
}
