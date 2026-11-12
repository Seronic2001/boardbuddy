import { importPKCS8, SignJWT, type CryptoKey } from "jose";

// Signs BuddySync room tokens. Server-only: needs SYNC_PRIVATE_KEY. Callers do the
// authorization; this only shapes and signs what the sync server verifies.

export const TOKEN_TTL_SECONDS = 5 * 60;

export type RoomTokenClaims = {
  userId: string;
  boardId: string;
  orgId: string;
  role: "editor" | "viewer";
  name: string;
  picture?: string;
};

let signingKey: Promise<CryptoKey> | null = null;
function getSigningKey(pem: string) {
  // Env vars usually carry PEMs with literal "\n".
  signingKey ??= importPKCS8(pem.replace(/\\n/g, "\n"), "EdDSA");
  return signingKey;
}

/** Response body for the client's `authenticate` (AuthResult in @boardbuddy/sync-client). */
export async function issueRoomToken(
  claims: RoomTokenClaims,
  config: { privateKey: string; syncUrl: string },
) {
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = await new SignJWT({
    boardId: claims.boardId,
    orgId: claims.orgId,
    role: claims.role,
    name: claims.name,
    picture: claims.picture,
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setSubject(claims.userId)
    .setIssuer("boardbuddy")
    .setAudience("buddysync")
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(await getSigningKey(config.privateKey));

  return {
    token,
    userId: claims.userId,
    name: claims.name,
    picture: claims.picture,
    expiresAt: expiresAt * 1000,
    url: config.syncUrl,
  };
}
