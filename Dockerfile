# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────
# Stohr — single-container image.
#
# Runs the API (:3000) and the SPA web server (:3001) together in one
# container. The web server serves the SPA and proxies /api/* to the API,
# so you only need to publish :3001. Migrations run automatically on API
# startup.
#
# BUILD — the libs/atlas submodule must be checked out first:
#   git submodule update --init
#   docker build -t stohr .
#
# RUN — needs an external Postgres. Storage is either an S3-compatible
# bucket (STORAGE_DRIVER=s3) or a mounted volume (STORAGE_DRIVER=local):
#   docker run -d --name stohr -p 80:3001 \
#     -e SECRET="$(openssl rand -hex 32)" \
#     -e DATABASE_URL=postgres://user:pass@host:5432/stohr \
#     -e APP_URL=https://files.example.com \
#     -e RP_ID=files.example.com -e RP_ORIGIN=https://files.example.com \
#     -e STORAGE_DRIVER=local -v stohr-blobs:/data/blobs \
#     stohr
#
# Full env var reference: docs/CONFIGURATION.md
#
# compose.yaml and .do/app.yaml reuse this image but override the command
# to run the API and web processes as separate containers.
# ─────────────────────────────────────────────────────────────────────────

# ---- deps: resolve + install into its own cached layer ------------------
FROM oven/bun:1-alpine AS deps
WORKDIR /app
# The @atlas/* deps are workspace packages, so libs/atlas/packages/* must be
# present for `bun install` to resolve them.
COPY package.json bun.lock ./
COPY libs/ ./libs/
RUN bun install --frozen-lockfile --production

# ---- runtime ------------------------------------------------------------
FROM oven/bun:1-alpine AS runtime
WORKDIR /app

# NODE_ENV=production is mandatory: src/web/serve.ts only bundles the SPA
# with the production React runtime when it's set, and src/server.ts
# refuses to boot on the default SECRET outside development.
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_PORT=3001 \
    API_URL=http://127.0.0.1:3000 \
    STORAGE_LOCAL_DIR=/data/blobs

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=deps --chown=bun:bun /app/libs ./libs
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun migrations/ ./migrations/
COPY --chown=bun:bun src/ ./src/

# Blob store for STORAGE_DRIVER=local — mount a volume here to persist it
# (`-v stohr-blobs:/data/blobs`). Unused/empty when STORAGE_DRIVER=s3.
RUN mkdir -p /data/blobs && chown bun:bun /data/blobs

USER bun
EXPOSE 3001 3000

# Hits GET /api/setup through the web proxy — exercises web + API + DB in
# one check. bun is used directly so this works on any base image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||3001)+'/api/setup').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Runs the API and web server together via the production foreman.
CMD ["bun", "src/start.ts"]
