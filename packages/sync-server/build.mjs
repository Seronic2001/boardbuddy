// Bundles the server and the migration runner into dist/ as standalone ESM files, so the
// production image needs no node_modules, TypeScript or tsx.
//   dist/main.mjs     the sync server
//   dist/migrate.mjs  applies ../migrations/*.sql (the image runs it on start)
import { build } from "esbuild";

await build({
  entryPoints: { main: "src/main.ts", migrate: "scripts/migrate.ts" },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  // Optional native add-ons that pg and ws load only if installed.
  external: ["pg-native", "bufferutil", "utf-8-validate"],
  // pg and ws are CommonJS and call require(); give the ESM bundle a real one.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
