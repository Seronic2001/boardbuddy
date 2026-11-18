import { loadPublicKey } from "./auth";
import { GroupCommitPersister } from "./group-commit";
import { MemoryPersister, type Persister } from "./persister";
import { PostgresPersister } from "./postgres";
import { startSyncServer } from "./server";

const log = (event: string, data: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));

const publicKeyPem = process.env.SYNC_PUBLIC_KEY;
if (!publicKeyPem) {
  console.error("SYNC_PUBLIC_KEY is not set. Generate a key pair with: npm run keys -w @boardbuddy/sync-server");
  process.exit(1);
}

// SYNC_GROUP_COMMIT=off gives one transaction per room flush (for benchmark comparisons).
const postgres = process.env.DATABASE_URL ? new PostgresPersister(process.env.DATABASE_URL) : null;
const persister: Persister = !postgres
  ? new MemoryPersister()
  : process.env.SYNC_GROUP_COMMIT === "off"
    ? postgres
    : new GroupCommitPersister(postgres);

const server = await startSyncServer({
  port: Number(process.env.PORT ?? 8787),
  publicKey: await loadPublicKey(publicKeyPem),
  persister,
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim()),
  log,
});
log("listening", {
  port: server.port,
  storage: postgres ? "postgres" : "memory",
  groupCommit: postgres !== null && persister !== postgres,
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("shutdown", { signal });
  await server.close(); // flushes every room's pending writes first
  await persister.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
