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

**Verification path:** there is no build step. Type-check with `bunx tsc --noEmit` and run `bun run test`. The `lint` / `format` / `check` scripts do cover `src/` and `scripts/` — they are a usable gate. `bun run check` is clean of errors; it still reports ~219 a11y/hook warnings concentrated in `src/web/app.tsx` (see "Known lint debt" below).

**Never run Biome's `--unsafe` fixes on `src/web/app.tsx`.** `useExhaustiveDependencies` will "fix" `useEffect(() => { load() }, [currentId])` into `}, [load]`. None of the `load`/`refresh` functions in that file are wrapped in `useCallback`, so they get a fresh identity every render and the effect then re-runs on every render — an infinite loop that both type-checks and builds. The repo's own `check:fix` / `tidy` scripts use plain `--write` (safe fixes only) and are fine.

`.env` is required at runtime. Copy `.env.example` — it is the source of truth for env vars (the README defers to `docs/CONFIGURATION.md` for the full reference).

## Stack and architecture

TypeScript + Bun server + React 19 (client) + Postgres + pluggable blob storage (S3-compatible bucket or local disk). All code is functional (no classes) per repo convention.

### Monorepo shape

Root `package.json` depends on `atlas` (installed via `github:wess/atlas#main`); the single git package vendors every `@atlas/<name>` subpackage under `node_modules/atlas/packages/`. `@atlas/<name>` imports in `src/` resolve through `tsconfig.json` `paths` entries — bun reads tsconfig at runtime. To bump atlas, run `bun update atlas`. Atlas's per-package reference docs live at `node_modules/atlas/packages/<name>/AGENTS.md`; `node_modules/atlas/SOUL.md` and `node_modules/atlas/llms.txt` are the AI-session entry points (or read them on GitHub at wess/atlas).

### Request pipeline

`src/server.ts` is the composition root. It:
1. Builds a typed config via `@atlas/config`'s `defineConfig` + `env(...)` helpers
2. Opens a Postgres `Connection` via `@atlas/db#connect`
3. Builds a `StorageHandle` via `src/storage/index.ts#createStorage` — picks a driver from `STORAGE_DRIVER` (`s3` or `local`)
4. Builds an emailer via `src/email/index.ts#createEmailer`
5. Runs migrations from `./migrations` via `@atlas/migrate#migrate.up`
6. Registers routes from ~58 feature-module factories (~242 routes) into the `@atlas/server` router
7. Starts background sweeps on `setInterval`, then `Bun.serve` wrapped in `withSecurityHeaders`

Boot order matters: `SECRET` is validated **before** the DB connection and migrations, so a misconfigured production boot exits without touching the schema. Don't move it back down.

`connect()` is passed an explicit `pool` (`DB_POOL`, default 20). `@atlas/db` defaults to 5, which is a throughput ceiling — every authenticated request costs 2-3 queries and all the sweeps share the pool.

**Every background sweep is registered in `src/server.ts`** and wrapped in `guardedSweep` (skips a tick if the previous run is still going, logs failures). Sweeps must not schedule themselves from inside a route factory — `sessionRoutes` and `shareRoutes` used to, which hid them from the composition root, skipped the overlap guard, and started timers in any test that merely built the route table. Boot sweeps are staggered 750ms apart so startup doesn't contend for the whole pool at once.

`SIGTERM`/`SIGINT` drain in-flight requests via `server.stop(false)` then close the pool, with a 15s forced-exit backstop. Both the API and `src/web/serve.ts` do this.

Each feature lives at `src/<feature>/index.ts` (some span multiple files, e.g. `src/auth/*`, `src/oauth/*`) and exports a route-factory — `authRoutes`, `fileRoutes`, `oauthTokenRoutes`, `actionRoutes`, etc. Factory signatures **vary** by what the feature needs: most take `(db, secret)`, some also take `store`, `emailer`, `appUrl`, or a WebAuthn RP config object. Check `src/server.ts` for the exact wiring before adding a new module — write it in the same shape and wire it there.

Handler convention:
- `pipeline(requireAuth({ secret, db }))` produces a guard; add `parseJson` or `parseMultipart` for bodies. `requireAuth` accepts `{ secret, db, scope?, noOAuth? }` and authenticates three credential types: session JWTs (checked against the `sessions` table via `jti`), PATs (`stohr_pat_…`, SHA-256 hashed in `apps`), and OAuth access tokens. Routes that mint further credentials pass `noOAuth: true`; scoped OAuth routes pass `scope`.
- `authId(c)` reads `c.assigns.auth.id` — every module redefines this one-liner; `requireAuth` is what populates `c.assigns.auth`.
- Routes return `json(c, status, body)`; binary downloads use `stream(c, 200, body)` with `putHeader` to set content-type / content-disposition / content-length
- DB queries use `@atlas/db`'s `from("table").where(q => q("col").equals(x))...` fluent builder; use `raw("NOW()")` when you need literal SQL

API query params and JSON bodies accept both `snake_case` and `camelCase` (e.g. `folder_id` / `folderId`, `parent_id` / `parentId`). When adding new params, keep this dual-form pattern.

**Pagination:** listing endpoints take `limit` / `offset` (`src/util/paging.ts`, default 200, max 1000) and return a **bare JSON array** — four SDKs plus the SPA depend on that shape, so page metadata goes in `x-limit` / `x-offset` / `x-has-more` response headers, never an envelope. Always order by a tie-breaker column (`id`) alongside the sort key, or rows shift between pages when timestamps collide.

### Data model

Schema lives in two places: `src/schema/index.ts` (TS schema via `@atlas/db` `defineSchema`) **and** `migrations/<seq>_<name>/up.sql` + `down.sql` (hand-written SQL). Migrations are the source of truth at runtime — the TS schema is not auto-synced. When changing the DB, update both, and add a new numbered migration directory (never edit an applied one).

~40 tables across 55 migrations. The core blob model is `users` → `folders` (self-referential `parent_id` for nesting) → `files` → `file_versions`, plus `shares`. The rest back specific features: `collaborations`, `invites`, `apps` (PATs), `s3_access_keys`, `oauth_clients` / `oauth_authorization_codes` / `oauth_device_codes` / `oauth_refresh_tokens`, `sessions`, `webauthn_credentials` / `webauthn_challenges`, `password_resets`, `folder_actions` / `folder_action_runs` / `user_actions`, `rate_limits`, `audit_events`, `contact_messages`. `src/schema/index.ts` is the quickest way to see every column.

Soft-deletion pattern: `folders`, `files`, and `users` carry a `deleted_at` nullable timestamp. All list/read queries filter `deleted_at IS NULL`. The `/trash` module lists rows where `deleted_at IS NOT NULL` and exposes restore (`POST /files/:id/restore`, `POST /folders/:id/restore`) and purge (`DELETE .../:id/purge`). Purge cascades: delete shares → file_versions → files → folders, then `Promise.allSettled` drops storage keys. Always follow this order to avoid FK violations. Deleted user accounts get a 24h grace window then a hard-delete sweep; `requireAuth` rejects every credential type for a `deleted_at` user.

File versioning: uploading a file with the same `name` into the same folder archives the current row into `file_versions` (see `archiveCurrent` in `src/files/index.ts`) and increments `version` on the live row. Each version owns its own `storage_key`; restoring an older version moves its key back onto the live row and archives the replaced version. The current version is **not** in `file_versions` — `GET /files/:id/versions` composes it in-memory from the live row.

### Storage

`src/storage/` is the only place blob backends are touched. Layout:

- `src/storage/index.ts` — defines the `StorageDriver` interface (`put / get / drop`), the discriminated `StorageConfig`, and `createStorage(config)` dispatcher. Re-exports `put`, `fetchObject`, `drop`, `makeKey(userId, name)` for consumers — no consumer should ever import a driver directly.
- `src/storage/s3/index.ts` — S3-compatible driver (wraps `@atlas/storage`).
- `src/storage/local/index.ts` — disk-backed driver (single host; uses `Bun.write` / `Bun.file` under `STORAGE_LOCAL_DIR`, with a path-traversal guard).
- `src/storage/thumb.ts` — `sharp`-based image thumbnail helper invoked from the upload handler; thumbnails are stored as their own keys (`files.thumb_key`).

Adding a new backend is a new file in this directory plus a case in the `createStorage` dispatcher and the `StorageConfig` union. **All file CRUD must go through the API** — never expose presigned URLs or direct-to-bucket access to clients. The `StorageDriver` interface deliberately omits `signedUrl` to keep that contract enforceable.

`get(key, range?)` takes an optional inclusive `ByteRange` so `GET /files/:id/download` can answer HTTP Range requests with a 206 without pulling the whole object (browsers can't seek in `<video>`/`<audio>` otherwise, and Safari refuses to play at all). The local driver uses `BunFile.slice`; the S3 driver presigns a 60s URL internally and adds a `Range` header — that URL is used in-process and discarded, never handed to a client, so the no-presigned-URLs contract still holds. `src/files/range.ts` parses the header (suffix ranges, open-ended ranges, clamping, 416); multi-range requests deliberately fall back to the full object.

Storage keys have the shape `u<userId>/<timestamp><rand>/<sanitized-name>`. When you delete DB rows that reference storage, always call `drop(store, key)` afterwards (wrapped in `Promise.allSettled` — we tolerate storage errors rather than failing the API call, since the DB row is already gone).

### Web client

Single-file SPA: `src/web/app.tsx` (~5.8k lines — all React state + routing + UI in one file by design — do not split unless asked). `src/web/api.ts` is the typed API client; the bearer token lives in `localStorage` as `stohr_token`.

`src/web/serve.ts` is a Bun server on `WEB_PORT` that:
- Serves `index.html` for every SPA route (`/`, `/s/:token`, `/signup`, `/login`, `/contact`, `/app/*`, `/p/:username/:folderId`, `/oauth/authorize`, `/pair`, `/password/forgot`, `/password/reset`)
- Proxies anything under `/api/*` to `API_URL` (stripping `/api`), preserving headers (including the bearer token) and body
- `/` falls through to the login screen when logged out (since marketing lives in `site/` now), or the dashboard when logged in

The web client only ever talks to `/api/*` — never directly to the API port — so auth headers flow through the proxy. Public routes (`/s/:token` share download, `/p/...` public folders) are the only API routes that don't require a bearer.

### Marketing site (`site/`)

The landing page, developer page, get-started page, and rendered docs live in `site/` as a standalone static site — built with Bun's HTML bundler + `marked` for the docs — deployed to Cloudflare Pages. The app SPA at `src/web/` no longer carries any marketing surface. See `site/README.md` for the build/deploy specifics; the docs index lives in `site/src/docs/render.tsx#DOCS_INDEX` (each entry pulls a `docs/*.md` or root `.md` from this repo at build time and renders it via React SSR + marked).

When you change a `docs/*.md` file in this repo, rebuild the site (`cd site && bun run build`) — the rendered HTML is regenerated from source, no per-doc updates needed elsewhere.

## Security invariants worth knowing before you edit

**Search snippets are escaped server-side.** `ts_headline` does not escape the document text it wraps, and file contents are attacker-controlled — a file containing `<img src=x onerror=...>` used to reach the SPA as live markup (the SPA renders snippets with `dangerouslySetInnerHTML`). `src/search/content/routes.ts` marks hits with control-character sentinels, HTML-escapes the whole snippet, then converts only the sentinels to `<mark>`. Don't reintroduce `StartSel=<b>`, and don't drop `renderSnippet`. Regression test: `tests/content_search.test.ts`.

**The SPA document gets security headers too.** `withSecurityHeaders` only wraps the API router; `src/web/serve.ts` applies `securityHeaders()` from `src/security/headers.ts` to the HTML and assets it serves, or the actual page the browser executes would ship with no CSP at all. The theme-init script in `index.html` must run before first paint, so it stays inline and is allowlisted by a sha256 hash computed from the shipped HTML at boot — edit the snippet and the hash follows it automatically. Don't add `'unsafe-inline'` to get around this.

**`ilike` patterns must go through `escapeLike`** (`src/search/parse.ts`), or a user searching `%` matches everything and `_` becomes a wildcard.

## Known lint debt

`bun run check` reports zero errors and ~219 warnings, all in `src/web/app.tsx`:

- `noStaticElementInteractions` (57) + `useKeyWithClickEvents` (54) — clickable `<div>` cards for files and folders are not keyboard-reachable. Real accessibility defect, deferred: fixing it properly means reworking the card components, and there are no component tests to catch a regression.
- `noLabelWithoutControl` (41) — form labels not wired to their inputs via `htmlFor`.
- `useExhaustiveDependencies` (33 after the safe autofixes) — see the `--unsafe` warning above; these need per-site judgment, not a codemod.
- `useMediaCaption` (5), `noArrayIndexKey` (2), `useSemanticElements` (2).

`noAutofocus` is turned **off** in `biome.json`: autofocus is used in modal dialogs where moving focus into the dialog is the correct behavior. `useButtonType` is satisfied — every `<button>` carries an explicit `type` (there are no `<form>` elements in the app, so this was cosmetic, but it's consistent now).

## Conventions (enforced)

From the user's global rules; the existing code already follows them:
- Functional style, no classes
- File names are lowercase; no spaces, `-`, or `_`. Modules live at `src/<feature>/index.ts` (not `src/feature-name.ts`)
- Small, hyper-focused files
- Bun, not Node/npm

Do not author git commit messages, PRs, or any text that mentions Claude / Anthropic. The user handles all git operations.
