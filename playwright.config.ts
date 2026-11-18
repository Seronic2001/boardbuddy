import { generateKeyPairSync } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests: real browsers on the real canvas, through the test-only /e2e pages
 * (no Clerk or Convex; see lib/e2e.ts).
 *
 * Locally, already-running servers are reused (`npm run dev` and `npm run sync:dev`, with
 * E2E_TEST_AUTH=1 in .env.local). Run both or neither: if neither is running, Playwright
 * starts both with a fresh key pair; if only one is, their keys won't match.
 * On CI, both are always started fresh.
 */

const APP_PORT = 3000;
const SYNC_PORT = 8787;
const oneLine = (pem: string) => pem.trim().replace(/\r?\n/g, "\\n");

// Only used when Playwright starts the servers itself.
const keys = generateKeyPairSync("ed25519");
const privateKey = oneLine(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
const publicKey = oneLine(keys.publicKey.export({ type: "spki", format: "pem" }).toString());

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${APP_PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      // In-memory storage; DATABASE_URL is not set.
      command: "npm run start -w @boardbuddy/sync-server",
      port: SYNC_PORT,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(SYNC_PORT), SYNC_PUBLIC_KEY: publicKey },
      stdout: "ignore",
      timeout: 60_000,
    },
    {
      command: `npx next dev --port ${APP_PORT}`,
      url: `http://localhost:${APP_PORT}/e2e/board/e2e-ready`,
      reuseExistingServer: !process.env.CI,
      env: {
        E2E_TEST_AUTH: "1",
        SYNC_PRIVATE_KEY: privateKey,
        NEXT_PUBLIC_SYNC_URL: `ws://localhost:${SYNC_PORT}`,
      },
      timeout: 180_000,
    },
  ],
});
