import { describe, expect, it } from "vitest";
import { matches, Revocations } from "../src/revocations";

describe("Revocations", () => {
  const claims = (orgId: string, userId: string, issuedAt: number) => ({ orgId, userId, issuedAt });

  it("refuses tokens issued before the revocation plus the grace period", () => {
    const now = 1_000_000;
    const r = new Revocations({ graceMs: 90_000, maxTokenLifetimeMs: 300_000, now: () => now });
    r.revoke({ orgId: "o", userId: "u" });
    expect(r.isRevoked(claims("o", "u", now - 1))).toBe(true);
    expect(r.isRevoked(claims("o", "u", now + 60_000))).toBe(true); // stale Clerk session
    expect(r.isRevoked(claims("o", "u", now + 91_000))).toBe(false); // re-added later
    expect(r.isRevoked(claims("o", "other", now))).toBe(false);
    expect(r.isRevoked(claims("p", "u", now))).toBe(false);
  });

  it("supports org-wide and user-wide revocations", () => {
    const r = new Revocations({ now: () => 0 });
    r.revoke({ orgId: "o" });
    r.revoke({ userId: "u" });
    expect(r.isRevoked(claims("o", "anyone", 0))).toBe(true);
    expect(r.isRevoked(claims("elsewhere", "u", 0))).toBe(true);
    expect(r.isRevoked(claims("elsewhere", "v", 0))).toBe(false);
    expect(() => r.revoke({})).toThrow();
  });

  it("forgets entries once every token they could block has expired", () => {
    let now = 0;
    const r = new Revocations({ graceMs: 10, maxTokenLifetimeMs: 100, now: () => now });
    r.revoke({ orgId: "o", userId: "u" });
    now = 105;
    r.revoke({ orgId: "o", userId: "v" }); // pruning happens on revoke
    expect(r.size).toBe(2);
    now = 111;
    r.revoke({ orgId: "o", userId: "w" });
    expect(r.size).toBe(2);
  });

  it("matches live sessions regardless of token age", () => {
    expect(matches({ orgId: "o" }, { orgId: "o", userId: "u" })).toBe(true);
    expect(matches({ orgId: "o", userId: "u" }, { orgId: "o", userId: "v" })).toBe(false);
    expect(matches({ userId: "u" }, { orgId: "p", userId: "u" })).toBe(true);
  });
});
