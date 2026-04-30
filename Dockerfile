# syntax=docker/dockerfile:1.7
#
# Three-stage build:
#   1. bun-deps     — installs JS/TS workspace deps
#   2. rust-builder — compiles libs/bai/native/rust → libbai.so (debian, glibc)
#   3. runtime      — debian-slim + bun + node_modules + libbai
#
# The runtime image is debian-based (not alpine) because llama.cpp / libbai
# is built against glibc; running a glibc .so on musl fails at dlopen.
# Image is ~30 MB larger than alpine but stays self-contained.

# ── Stage 1: JS deps ─────────────────────────────────────────────────────
FROM oven/bun:1-alpine AS bun-deps
WORKDIR /app
# Install workspace deps in a separate layer so source-only changes don't
# blow the cache.
ENV BAI_SKIP_POSTINSTALL=1
COPY package.json bun.lock ./
COPY libs/ ./libs/
RUN bun install --frozen-lockfile --production


# ── Stage 2: Native libbai ───────────────────────────────────────────────
FROM rust:1-bookworm AS rust-builder
WORKDIR /build

# llama.cpp needs cmake + a C++ toolchain; build-essential covers the rest.
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      cmake build-essential libssl-dev pkg-config \
      clang libclang-dev && \
    rm -rf /var/lib/apt/lists/*

# Copy the full crate and build in one shot. Cargo's registry +
# git caches are mounted as buildx cache volumes so subsequent rebuilds
# (when only src/ changes) skip the dep download but still recompile
# bai itself. This is simpler than the stub-trick and produces a fully
# linked .so on every build instead of a 67KB stub.
COPY libs/bai/native/rust/Cargo.toml libs/bai/native/rust/Cargo.lock ./
COPY libs/bai/native/rust/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target,sharing=locked \
    cargo build --release --no-default-features --features cpu && \
    cp target/release/libbai.so /tmp/libbai.so


# ── Stage 3: Runtime ─────────────────────────────────────────────────────
FROM oven/bun:1-debian AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=bun-deps /app/node_modules ./node_modules
COPY --from=bun-deps /app/libs ./libs
COPY package.json bun.lock ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY tsconfig.json ./

# Drop libbai where the bai FFI loader looks for it. The path matches
# `resolveLibPath()` in libs/bai/ffi/lib.ts so no env override is needed.
RUN mkdir -p /root/.cache/bai/lib /root/.cache/bai/models
COPY --from=rust-builder /tmp/libbai.so /root/.cache/bai/lib/libbai.so

# AI is opt-in: leave AI_EMBED_MODEL unset (default in compose.yaml) and
# the API boots fine without ever loading the lib. When set, the bai FFI
# layer dlopens libbai.so on first use.

EXPOSE 3000 3001

# `command:` in compose.yaml selects between api / web entry points.
CMD ["bun", "src/server.ts"]
