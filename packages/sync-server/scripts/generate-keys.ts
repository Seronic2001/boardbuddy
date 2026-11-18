import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

// Ed25519 key pair for room tokens. The private key goes to the Next.js app (which signs),
// the public key to the sync server (which only verifies).
const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
const oneLine = (pem: string) => pem.trim().replace(/\r?\n/g, "\\n");

console.log("# Next.js app (.env.local):");
console.log(`SYNC_PRIVATE_KEY="${oneLine(await exportPKCS8(privateKey))}"`);
console.log("NEXT_PUBLIC_SYNC_URL=ws://localhost:8787");
console.log("");
console.log("# Sync server (packages/sync-server/.env):");
console.log(`SYNC_PUBLIC_KEY="${oneLine(await exportSPKI(publicKey))}"`);
