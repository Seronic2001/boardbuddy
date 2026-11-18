import { importSPKI, jwtVerify, type CryptoKey, type KeyObject } from "jose";

/**
 * Room tokens are short-lived EdDSA (Ed25519) JWTs signed by the Next.js /api/sync-auth
 * route after it has checked Clerk and Convex. This server holds only the public key, so
 * it never needs Clerk or Convex secrets.
 */

export const TOKEN_ISSUER = "boardbuddy";
export const TOKEN_AUDIENCE = "buddysync";
/** Audience of admin tokens (signed by the Next.js app for server-to-server calls). */
export const ADMIN_AUDIENCE = "buddysync-admin";

export type Role = "editor" | "viewer";

export type RoomClaims = {
  userId: string;
  boardId: string;
  orgId: string;
  role: Role;
  name: string;
  picture?: string;
  /** Expiry, ms since epoch. */
  expiresAt: number;
  /** Issue time, ms since epoch (second precision). Checked against revocations. */
  issuedAt: number;
};

export type PublicKey = CryptoKey | KeyObject;

export function loadPublicKey(pem: string): Promise<PublicKey> {
  // Env vars usually carry PEMs with literal "\n".
  return importSPKI(pem.replace(/\\n/g, "\n"), "EdDSA");
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly expired = false,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function verifyRoomToken(token: string, key: PublicKey): Promise<RoomClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      algorithms: ["EdDSA"],
      requiredClaims: ["sub", "exp", "iat"],
    }));
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new AuthError(
      code === "ERR_JWT_EXPIRED" ? "Token expired" : "Invalid token",
      code === "ERR_JWT_EXPIRED",
    );
  }
  const { sub, exp, iat, boardId, orgId, role, name, picture } = payload as Record<string, unknown>;
  if (typeof sub !== "string" || !ID.test(sub)) throw new AuthError("Invalid subject");
  if (typeof boardId !== "string" || !ID.test(boardId)) throw new AuthError("Invalid boardId");
  if (typeof orgId !== "string" || orgId.length === 0) throw new AuthError("Invalid orgId");
  if (role !== "editor" && role !== "viewer") throw new AuthError("Invalid role");
  return {
    userId: sub,
    boardId,
    orgId,
    role,
    name: typeof name === "string" && name.length > 0 ? name.slice(0, 64) : "Teammate",
    ...(typeof picture === "string" && picture.startsWith("https://") ? { picture } : {}),
    expiresAt: (exp as number) * 1000,
    issuedAt: (iat as number) * 1000,
  };
}

export type AdminRequest = { action: "revoke"; orgId?: string; userId?: string };

/**
 * Admin tokens carry the request itself, so a token can't be replayed for another action.
 * They are short-lived (the app signs them for 60 s) and use the same key pair.
 */
export async function verifyAdminToken(token: string, key: PublicKey): Promise<AdminRequest> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key, {
      issuer: TOKEN_ISSUER,
      audience: ADMIN_AUDIENCE,
      algorithms: ["EdDSA"],
      requiredClaims: ["exp"],
      maxTokenAge: "5m",
    }));
  } catch {
    throw new AuthError("Invalid admin token");
  }
  const { action, orgId, userId } = payload as Record<string, unknown>;
  const optionalId = (v: unknown) => v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 128);
  if (action !== "revoke" || !optionalId(orgId) || !optionalId(userId) || (!orgId && !userId)) {
    throw new AuthError("Invalid admin request");
  }
  return {
    action,
    ...(typeof orgId === "string" ? { orgId } : {}),
    ...(typeof userId === "string" ? { userId } : {}),
  };
}
