import { describe, expect, it } from "vitest";

import { e2eUserId, isE2eBoardId, isE2eEnabled, parseE2eTokenRequest } from "./e2e";

describe("isE2eEnabled", () => {
  it("needs E2E_TEST_AUTH=1", () => {
    expect(isE2eEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(isE2eEnabled({ NODE_ENV: "development", E2E_TEST_AUTH: "true" })).toBe(false);
    expect(isE2eEnabled({ NODE_ENV: "development", E2E_TEST_AUTH: "1" })).toBe(true);
    expect(isE2eEnabled({ NODE_ENV: "test", E2E_TEST_AUTH: "1" })).toBe(true);
  });

  it("is never on in production, even with the flag", () => {
    expect(isE2eEnabled({ NODE_ENV: "production", E2E_TEST_AUTH: "1" })).toBe(false);
  });
});

describe("isE2eBoardId", () => {
  it("accepts only e2e- ids", () => {
    expect(isE2eBoardId("e2e-offline-merge")).toBe(true);
    expect(isE2eBoardId("e2e-")).toBe(false);
    expect(isE2eBoardId("j576z4has1532bd8ta0qp6929x8j3v1x")).toBe(false); // a Convex id
    expect(isE2eBoardId("E2E-x")).toBe(false);
    expect(isE2eBoardId("e2e-../x")).toBe(false);
    expect(isE2eBoardId(`e2e-${"a".repeat(61)}`)).toBe(false);
    expect(isE2eBoardId(42)).toBe(false);
  });
});

describe("parseE2eTokenRequest", () => {
  it("defaults to editor", () => {
    expect(parseE2eTokenRequest({ room: "e2e-a", user: "alice" })).toEqual({
      boardId: "e2e-a",
      user: "alice",
      role: "editor",
    });
  });

  it("allows viewer", () => {
    expect(parseE2eTokenRequest({ room: "e2e-a", user: "bob", role: "viewer" })?.role).toBe("viewer");
  });

  it("rejects real boards, bad users and bad roles", () => {
    expect(parseE2eTokenRequest({ room: "j576z4has1532bd8ta0qp6929x8j3v1x", user: "alice" })).toBeNull();
    expect(parseE2eTokenRequest({ room: "e2e-a" })).toBeNull();
    expect(parseE2eTokenRequest({ room: "e2e-a", user: "" })).toBeNull();
    expect(parseE2eTokenRequest({ room: "e2e-a", user: "a b" })).toBeNull();
    expect(parseE2eTokenRequest({ room: "e2e-a", user: "alice", role: "owner" })).toBeNull();
    expect(parseE2eTokenRequest(null)).toBeNull();
    expect(parseE2eTokenRequest("e2e-a")).toBeNull();
  });
});

describe("e2eUserId", () => {
  it("is prefixed so it can't be a Clerk id", () => {
    expect(e2eUserId("alice")).toBe("e2e_alice");
  });
});
