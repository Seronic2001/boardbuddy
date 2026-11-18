import { describe, expect, it } from "vitest";
import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from "jose";
import { loadPublicKey, TOKEN_AUDIENCE, TOKEN_ISSUER, verifyRoomToken } from "../src/auth";

describe("room tokens", () => {
  it("one-line env PEMs work end to end: Next route signs, sync server verifies", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    // The format generate-keys.ts prints and .env files carry.
    const envPrivate = (await exportPKCS8(privateKey)).trim().replace(/\r?\n/g, "\\n");
    const envPublic = (await exportSPKI(publicKey)).trim().replace(/\r?\n/g, "\\n");
    expect(envPublic).not.toContain("\n");

    // Same steps as app/api/sync-auth/route.ts.
    const signing = await importPKCS8(envPrivate.replace(/\\n/g, "\n"), "EdDSA");
    const token = await new SignJWT({
      boardId: "board_1",
      orgId: "org_1",
      role: "editor",
      name: "Ada",
      picture: "https://img.clerk.com/a.png",
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("user_1")
      .setIssuer("boardbuddy")
      .setAudience("buddysync")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signing);

    const claims = await verifyRoomToken(token, await loadPublicKey(envPublic));
    expect(claims).toMatchObject({
      userId: "user_1",
      boardId: "board_1",
      orgId: "org_1",
      role: "editor",
      name: "Ada",
      picture: "https://img.clerk.com/a.png",
    });
    expect(TOKEN_ISSUER).toBe("boardbuddy");
    expect(TOKEN_AUDIENCE).toBe("buddysync");
  });

  it("rejects tokens with a wrong audience or a non-EdDSA algorithm", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const wrongAud = await new SignJWT({ boardId: "b", orgId: "o", role: "editor" })
      .setProtectedHeader({ alg: "EdDSA" })
      .setSubject("user_1")
      .setIssuer(TOKEN_ISSUER)
      .setAudience("liveblocks")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(verifyRoomToken(wrongAud, publicKey)).rejects.toThrow("Invalid token");

    const hmac = await new SignJWT({ boardId: "b", orgId: "o", role: "editor" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("user_1")
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("x".repeat(32)));
    await expect(verifyRoomToken(hmac, publicKey)).rejects.toThrow("Invalid token");
  });
});
