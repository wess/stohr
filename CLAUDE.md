# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Bun is the runtime, package manager, and bundler — never use `node`/`npm`.

- `bun install` — install deps
- `bun run dev` — start both API (`:3000`) and web (`:3001`) via `@atlas/cli` foreman (src/dev.ts)
- `bun run api` — API only, with `--hot`
- `bun run web` — web only, with `--hot`

No test, lint, or build scripts are defined. Type-checking runs implicitly via `tsc --noEmit` semantics of `tsconfig.json` (run `bunx tsc --noEmit` if needed).

`.env` is required at runtime. Copy `.env.example`. Note that `.env.example` is the source of truth for env vars — the README's env table is out of date (says SQLite/local disk; the code actually uses Postgres + S3-compatible storage).

## Stack and architecture

TypeScript + Bun server + React 19 (client) + Postgres + S3-compatible object store. All code is functional (no classes) per repo convention.

### Monorepo shape

Root `package.json` declares `workspaces: ["libs/atlas/packages/*"]` and depends on `@atlas/{auth,cli,config,db,migrate,server,storage}` via `workspace:*`. `libs/atlas/` is a **git submodule** pointing to `https://github.com/wess/atlas.git` — treat it as vendor source, don't edit it here. To pull upstream changes, run `git -C libs/atlas pull` then commit the bumped pointer in this repo.

### Request pipeline

`src/server.ts` is the composition root. It:
1. Builds a typed config via `@atlas/config`'s `defineConfig` + `env(...)` helpers
2. Opens a Postgres `Connection` via `@atlas/db#connect`
3. Builds a `StorageHandle` via `src/storage/index.ts#createStorage` (thin wrapper over `@atlas/storage`)
4. Runs migrations from `./migrations` via `@atlas/migrate#migrate.up`
5. Registers routes from each feature module

Each feature module under `src/<feature>/index.ts` exports a single factory — `authRoutes`, `userRoutes`, `folderRoutes`, `fileRoutes`, `shareRoutes`, `trashRoutes` — that takes `(db, secret, store?)` and returns an array of routes. Add new routes by writing a new module in the same shape and wiring it into `server.ts`.

Handler convention:
- `pipeline(requireAuth({ secret }))` produces a guard; add `parseJson` or `parseMultipart` for bodies
- `authId(c)` reads `c.assigns.auth.id` — every module redefines this one-liner; the auth middleware is what populates it
- Routes return `json(c, status, body)`; binary downloads use `stream(c, 200, body)` with `putHeader` to set content-type / content-disposition / content-length
- DB queries use `@atlas/db`'s `from("table").where(q => q("col").equals(x))...` fluent builder; use `raw("NOW()")` when you need literal SQL

API query params and JSON bodies accept both `snake_case` and `camelCase` (e.g. `folder_id` / `folderId`, `parent_id` / `parentId`). When adding new params, keep this dual-form pattern.

### Data model

Schema lives in two places: `src/schema/index.ts` (TS schema via `@atlas/db` `defineSchema`) **and** `migrations/<timestamp>_<name>/up.sql` + `down.sql` (hand-written SQL). Migrations are the source of truth at runtime — the TS schema is not auto-synced. When changing the DB, update both.

Tables: `users`, `folders` (self-referential `parent_id` for nesting), `files`, `file_versions`, `shares`.

Soft-deletion pattern: `folders` and `files` have a `deleted_at` nullable timestamp. All list/read queries filter `deleted_at IS NULL`. The `/trash` module lists rows where `deleted_at IS NOT NULL` and exposes restore (`POST /files/:id/restore`, `POST /folders/:id/restore`) and purge (`DELETE .../:id/purge`) endpoints. Purge cascades: delete shares → file_versions → files → folders, then `Promise.allSettled` drops storage keys. Always follow this order to avoid FK violations.

File versioning: uploading a file with the same `name` into the same folder archives the current row into `file_versions` (see `archiveCurrent` in `src/files/index.ts`) and increments `version` on the live row. Each version owns its own `storage_key`; restoring an older version moves its key back onto the live row and archives the replaced version. The current version is **not** in `file_versions` — `GET /files/:id/versions` composes it in-memory from the live row.

### Storage

`src/storage/index.ts` is the only module that talks to `@atlas/storage`. It exposes `put`, `fetchObject`, `drop`, `signedUrl`, and `makeKey(userId, name)`. Storage keys have the shape `u<userId>/<timestamp><rand>/<sanitized-name>`. When you delete DB rows that reference storage, always call `drop(store, key)` afterwards (wrapped in `Promise.allSettled` — we tolerate storage errors rather than failing the API call, since the DB row is already gone).

### Web client

Single-file SPA: `src/web/app.tsx` (~42KB, all React state + routing + UI in one file by design — do not split unless asked). `src/web/api.ts` is the typed API client; token lives in `localStorage` as `stohr_token`.

`src/web/serve.ts` is a Bun server on `WEB_PORT` that:
- Serves `index.html` for `/`, `/s/:token`, `/app/*`
- Proxies anything under `/api/*` to `API_URL` (stripping `/api`), preserving headers (including the bearer token) and body

The web client only ever talks to `/api/*` — never directly to the API port — so auth headers flow through the proxy. Public share download (`/s/:token`) is the only API route that does not require a bearer.

## Conventions (enforced)

From the user's global rules; the existing code already follows them:
- Functional style, no classes
- File names are lowercase; no spaces, `-`, or `_`. Modules live at `src/<feature>/index.ts` (not `src/feature-name.ts`)
- Small, hyper-focused files
- Bun, not Node/npm

Do not author git commit messages, PRs, or any text that mentions Claude / Anthropic. The user handles all git operations.
