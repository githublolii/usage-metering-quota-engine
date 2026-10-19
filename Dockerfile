# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — build: compile TypeScript to plain JavaScript
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install ALL dependencies first (cached layer, then copy source for cache hits)
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public ./public

RUN npm run build

# Prune to production dependencies for the runtime stage
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2 — runtime: minimal, non-root, production-only image
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    TZ=UTC

# Non-root user (node image ships with uid 1000 `node`)
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --from=build --chown=node:node /app/dist/scripts ./dist/scripts
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# migrations + seed run automatically at boot → `docker compose up --build`
# is the ONLY command needed to get a fully working stack.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Raw SQL migrations are read from disk at runtime — ship them with the app.
COPY --from=build --chown=node:node /app/dist/src/database/migrations ./dist/src/database/migrations

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/server.js"]
