import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests for app code under lib/ (workspace packages have their own configs).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["lib/**/*.test.{ts,tsx}"],
  },
});
