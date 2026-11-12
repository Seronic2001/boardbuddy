import { defineConfig } from "vitest/config";

// Own config so Vitest does not pick up the app config at the repo root.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
