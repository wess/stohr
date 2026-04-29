FROM oven/bun:1-alpine AS deps
WORKDIR /app

# Install workspace deps in a separate layer so source-only changes don't
# blow the cache.
COPY package.json bun.lock ./
COPY libs/ ./libs/
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/libs ./libs
COPY package.json bun.lock ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY tsconfig.json ./

EXPOSE 3000 3001

# `command:` in compose.yaml selects between api / web entry points.
CMD ["bun", "src/server.ts"]
