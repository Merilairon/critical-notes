# syntax=docker/dockerfile:1
# Critical Notes: the server bundle and the web app on plain Node, running as the unprivileged `node` user.
# The 5etools data is not in the image: mount the clones (see docker-compose.yml).
ARG NODE_VERSION=24.15.0

# 1. Build the server bundle and the web app
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN npm install -g pnpm@11.0.9
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/blocks/package.json packages/blocks/
COPY packages/fivetools/package.json packages/fivetools/
COPY packages/shared/package.json packages/shared/
COPY packages/templates/package.json packages/templates/
# Install scripts are skipped: every native package here ships prebuilt binaries (better-sqlite3 in its own
# prebuilds/ folder, sharp, argon2 and esbuild as per-platform packages), so nothing needs compiling
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps apps
COPY packages packages
RUN pnpm --filter @cn/server build && pnpm --filter @cn/web build

# 2. Only the server's external runtime packages (native modules and 5etools-utils)
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY --from=build /src/apps/server/dist/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# 3. Runtime
FROM node:${NODE_VERSION}-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data/app \
    FIVETOOLS_SRC_PATH=/data/5etools-src \
    FIVETOOLS_IMG_PATH=/data/5etools-img \
    WEB_DIST_DIR=/app/web \
    PUBLIC_URL=http://localhost:3000 \
    CN_SKIP_DOTENV=1
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./
COPY --from=build /src/apps/web/dist/web/browser ./web
# License notices of what the image ships
COPY --from=build /src/apps/web/dist/web/3rdpartylicenses.txt ./licenses/web-3rdpartylicenses.txt
COPY THIRD_PARTY_NOTICES.md ./licenses/
RUN mkdir -p /data/app && chown node:node /data/app
USER node
VOLUME ["/data/app"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "main.mjs"]
