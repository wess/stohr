# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`docs/ARCHITECTURE.md` is the maintained, exhaustive map of the codebase — the full module layout, request pipeline, permissions model, and background sweeps. Read it. This file covers what an agent needs that the docs don't: commands, conventions, and gotchas.

## Commands

Bun is the runtime, package manager, and bundler — never use `node`/`npm`.

- `bun install` — install deps
- `bun run dev` — start both API (`:3000`) and web (`:3001`) via `@atlas/cli` foreman (`src/dev.ts`)
- `bun run api` — API only, with `--hot`
- `bun run web` — web only, with `--hot`
- `bun src/start.ts` — production entry: runs API + web together **without** `--hot` (the `Dockerfile`'s default `CMD`; `src/dev.ts` is the `--hot` equivalent)
- `bun run test` — Bun's test runner against an isolated `stohr_test` Postgres DB (auto-created on first run). Needs a local Postgres reachable with the dev credentials; override via `TEST_ADMIN_URL` / `TEST_DATABASE_URL`. See `tests/README.md`.

Deploy: the repo ships a single-container `Dockerfile` (runs both processes), plus `compose.yaml` (postgres + api + web + caddy) and `.do/app.yaml` (DO App Platform). See `docs/DEPLOY.md`.

**Verification path:** there is no build step. Type-check with `bunx tsc --noEmit` and run `bun run test`. The `lint` / `format` / `check` scripts in `package.json` invoke Biome against a `packages/` directory that does not exist in this repo (and `biome.json`'s `includes` is scoped the same way), so they currently lint nothing under `src/` — don't rely on them as a gate.

`.env` is required at runtime. Copy `.env.example` — it is the source of truth for env vars (the README defers to `docs/CONFIGURATION.md` for the full reference).

## Stack and architecture

TypeScript + Bun server + React 19 (client) + Postgres + pluggable blob storage (S3-compatible bucket or local disk). All code is functional (no classes) per repo convention.

### Monorepo shape

Root `package.json` declares `workspaces: ["libs/atlas/packages/*"]` and depends on `@atlas/{auth,cli,config,db,migrate,server,storage}` via `workspace:*`. `libs/atlas/` is a **git submodule** pointing to `https://github.com/wess/atlas.git` — treat it as vendor source, don't edit it here. To pull upstream changes, run `git -C libs/atlas pull` then commit the bumped pointer in this repo.

### Request pipeline

`src/server.ts` is the composition root. It:
1. Builds a typed config via `@atlas/config`'s `defineConfig` + `env(...)` helpers
2. Opens a Postgres `Connection` via `@atlas/db#connect`
3. Builds a `StorageHandle` via `src/storage/index.ts#createStorage` — picks a driver from `STORAGE_DRIVER` (`s3` or `local`)
4. Builds an emailer via `src/email/index.ts#createEmailer`
5. Runs migrations from `./migrations` via `@atlas/migrate#migrate.up`
6. Registers routes from ~30 feature-module factories into the `@atlas/server` router
7. Starts background sweeps on `setInterval` (expired OAuth codes / device codes / refresh tokens / password resets / WebAuthn challenges / soft-deleted accounts), then `Bun.serve` wrapped in `withSecurityHeaders`

Each feature lives at `src/<feature>/index.ts` (some span multiple files, e.g. `src/auth/*`, `src/oauth/*`) and exports a route-factory — `authRoutes`, `fileRoutes`, `oauthTokenRoutes`, `actionRoutes`, etc. Factory signatures **vary** by what the feature needs: most take `(db, secret)`, some also take `store`, `emailer`, `appUrl`, or a WebAuthn RP config object. Check `src/server.ts` for the exact wiring before adding a new module — write it in the same shape and wire it there.

Handler convention:
- `pipeline(requireAuth({ secret, db }))` produces a guard; add `parseJson` or `parseMultipart` for bodies. `requireAuth` accepts `{ secret, db, scope?, noOAuth? }` and authenticates three credential types: session JWTs (checked against the `sessions` table via `jti`), PATs (`stohr_pat_…`, SHA-256 hashed in `apps`), and OAuth access tokens. Routes that mint further credentials pass `noOAuth: true`; scoped OAuth routes pass `scope`.
- `authId(c)` reads `c.assigns.auth.id` — every module redefines this one-liner; `requireAuth` is what populates `c.assigns.auth`.
- Routes return `json(c, status, body)`; binary downloads use `stream(c, 200, body)` with `putHeader` to set content-type / content-disposition / content-length
- DB queries use `@atlas/db`'s `from("table").where(q => q("col").equals(x))...` fluent builder; use `raw("NOW()")` when you need literal SQL

API query params and JSON bodies accept both `snake_case` and `camelCase` (e.g. `folder_id` / `folderId`, `parent_id` / `parentId`). When adding new params, keep this dual-form pattern.

### Data model

Schema lives in two places: `src/schema/index.ts` (TS schema via `@atlas/db` `defineSchema`) **and** `migrations/<seq>_<name>/up.sql` + `down.sql` (hand-written SQL). Migrations are the source of truth at runtime — the TS schema is not auto-synced. When changing the DB, update both, and add a new numbered migration directory (never edit an applied one).

~23 tables across 37 migrations. The core blob model is `users` → `folders` (self-referential `parent_id` for nesting) → `files` → `file_versions`, plus `shares`. The rest back specific features: `collaborations`, `invites`, `apps` (PATs), `s3_access_keys`, `oauth_clients` / `oauth_authorization_codes` / `oauth_device_codes` / `oauth_refresh_tokens`, `sessions`, `webauthn_credentials` / `webauthn_challenges`, `password_resets`, `folder_actions` / `folder_action_runs` / `user_actions`, `rate_limits`, `audit_events`, `contact_messages`. `src/schema/index.ts` is the quickest way to see every column.

Soft-deletion pattern: `folders`, `files`, and `users` carry a `deleted_at` nullable timestamp. All list/read queries filter `deleted_at IS NULL`. The `/trash` module lists rows where `deleted_at IS NOT NULL` and exposes restore (`POST /files/:id/restore`, `POST /folders/:id/restore`) and purge (`DELETE .../:id/purge`). Purge cascades: delete shares → file_versions → files → folders, then `Promise.allSettled` drops storage keys. Always follow this order to avoid FK violations. Deleted user accounts get a 24h grace window then a hard-delete sweep; `requireAuth` rejects every credential type for a `deleted_at` user.

File versioning: uploading a file with the same `name` into the same folder archives the current row into `file_versions` (see `archiveCurrent` in `src/files/index.ts`) and increments `version` on the live row. Each version owns its own `storage_key`; restoring an older version moves its key back onto the live row and archives the replaced version. The current version is **not** in `file_versions` — `GET /files/:id/versions` composes it in-memory from the live row.

### Storage

`src/storage/` is the only place blob backends are touched. Layout:

- `src/storage/index.ts` — defines the `StorageDriver` interface (`put / get / drop`), the discriminated `StorageConfig`, and `createStorage(config)` dispatcher. Re-exports `put`, `fetchObject`, `drop`, `makeKey(userId, name)` for consumers — no consumer should ever import a driver directly.
- `src/storage/s3/index.ts` — S3-compatible driver (wraps `@atlas/storage`).
- `src/storage/local/index.ts` — disk-backed driver (single host; uses `Bun.write` / `Bun.file` under `STORAGE_LOCAL_DIR`, with a path-traversal guard).
- `src/storage/thumb.ts` — `sharp`-based image thumbnail helper invoked from the upload handler; thumbnails are stored as their own keys (`files.thumb_key`).

Adding a new backend is a new file in this directory plus a case in the `createStorage` dispatcher and the `StorageConfig` union. **All file CRUD must go through the API** — never expose presigned URLs or direct-to-bucket access to clients. The `StorageDriver` interface deliberately omits `signedUrl` to keep that contract enforceable.

Storage keys have the shape `u<userId>/<timestamp><rand>/<sanitized-name>`. When you delete DB rows that reference storage, always call `drop(store, key)` afterwards (wrapped in `Promise.allSettled` — we tolerate storage errors rather than failing the API call, since the DB row is already gone).

### Web client

Single-file SPA: `src/web/app.tsx` (~285KB — all React state + routing + UI in one file by design — do not split unless asked). `src/web/api.ts` is the typed API client; the bearer token lives in `localStorage` as `stohr_token`.

`src/web/serve.ts` is a Bun server on `WEB_PORT` that:
- Serves `index.html` for every SPA route (`/`, `/s/:token`, `/signup`, `/login`, `/developers`, `/contact`, `/app/*`, `/p/:username/:folderId`, `/oauth/authorize`, `/pair`, `/password/forgot`, `/password/reset`)
- Proxies anything under `/api/*` to `API_URL` (stripping `/api`), preserving headers (including the bearer token) and body

The web client only ever talks to `/api/*` — never directly to the API port — so auth headers flow through the proxy. Public routes (`/s/:token` share download, `/p/...` public folders) are the only API routes that don't require a bearer.

## Conventions (enforced)

From the user's global rules; the existing code already follows them:
- Functional style, no classes
- File names are lowercase; no spaces, `-`, or `_`. Modules live at `src/<feature>/index.ts` (not `src/feature-name.ts`)
- Small, hyper-focused files
- Bun, not Node/npm

Do not author git commit messages, PRs, or any text that mentions Claude / Anthropic. The user handles all git operations.
