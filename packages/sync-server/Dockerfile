# BuddySync sync server. Build from the repository root (it's an npm workspace):
#   docker build -f packages/sync-server/Dockerfile -t buddysync .
#
# Runtime env: SYNC_PUBLIC_KEY (required), DATABASE_URL, ALLOWED_ORIGINS, PORT (default 8080).
# Migrations: `node dist/migrate.mjs` (fly.toml runs it as the release_command).

# ---- build: install only the server's workspace deps, bundle to dist/ ------------------
FROM node:24-alpine AS build
WORKDIR /repo

# npm ci checks the lockfile against every workspace's package.json, so copy them all.
COPY package.json package-lock.json .npmrc ./
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/sync-client/package.json packages/sync-client/
COPY packages/sync-server/package.json packages/sync-server/
RUN npm ci --workspace @boardbuddy/sync-server --include-workspace-root=false --ignore-scripts --no-audit --no-fund

COPY packages/sync-core/src packages/sync-core/src
COPY packages/sync-server packages/sync-server
RUN npm run build -w @boardbuddy/sync-server

# ---- runtime: the bundle and the SQL migrations, nothing else ---------------------------
FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build --chown=node:node /repo/packages/sync-server/dist ./dist
COPY --from=build --chown=node:node /repo/packages/sync-server/migrations ./migrations
USER node
EXPOSE 8080
# Plain `node` as PID 1 receives SIGTERM directly; main.mjs flushes rooms before exiting.
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
