import type { RoomClaims } from "./auth";

/**
 * Access taken away (a member removed from an org, an org or user deleted). Revoking
 * closes the matching live sessions and rejects room tokens issued before the revocation
 * plus a grace period. The grace period exists because Clerk session tokens can carry
 * the old membership for up to a minute, so /api/sync-auth may still issue a token just
 * after the removal.
 *
 * In memory: room tokens live 5 minutes, so an entry can be dropped once every token it
 * could block has expired. After a restart, sessions reconnect with fresh tokens, which
 * /api/sync-auth refuses by then. Multi-node would need this broadcast to every node.
 */

export type Revocation = { orgId?: string; userId?: string };

export type RevocationOptions = {
  /** How long after a revocation newly issued tokens are still refused. */
  graceMs?: number;
  /** Longest room-token lifetime: an entry is dropped once every token it blocks expired. */
  maxTokenLifetimeMs?: number;
  now?: () => number;
};

export class Revocations {
  /** Key `${orgId ?? "*"}|${userId ?? "*"}` → refuse tokens issued at or before this ms. */
  private readonly until = new Map<string, number>();
  private readonly graceMs: number;
  private readonly maxTokenLifetimeMs: number;
  private readonly now: () => number;

  constructor(options: RevocationOptions = {}) {
    this.graceMs = options.graceMs ?? 90_000;
    this.maxTokenLifetimeMs = options.maxTokenLifetimeMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  revoke(r: Revocation): void {
    if (!r.orgId && !r.userId) throw new Error("A revocation needs an orgId or a userId");
    this.prune();
    const key = `${r.orgId ?? "*"}|${r.userId ?? "*"}`;
    this.until.set(key, Math.max(this.until.get(key) ?? 0, this.now() + this.graceMs));
  }

  /** Whether a session or token with these claims is no longer allowed. */
  isRevoked(claims: Pick<RoomClaims, "orgId" | "userId" | "issuedAt">): boolean {
    for (const key of [`${claims.orgId}|${claims.userId}`, `${claims.orgId}|*`, `*|${claims.userId}`]) {
      const until = this.until.get(key);
      if (until !== undefined && claims.issuedAt <= until) return true;
    }
    return false;
  }

  get size(): number {
    return this.until.size;
  }

  private prune(): void {
    const cutoff = this.now() - this.maxTokenLifetimeMs;
    for (const [key, until] of this.until) if (until < cutoff) this.until.delete(key);
  }
}

/** Matches a live session against a revocation (ignores token age: it is already connected). */
export function matches(r: Revocation, claims: Pick<RoomClaims, "orgId" | "userId">): boolean {
  return (r.orgId === undefined || r.orgId === claims.orgId) && (r.userId === undefined || r.userId === claims.userId);
}
