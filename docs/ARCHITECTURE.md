# Architecture

A high-level walk-through of what's running and how it fits together.

## Processes

```
                ┌────────────────┐
                │  Caddy :80/443 │  TLS, reverse proxy
                └────────┬───────┘
                         │
                ┌────────▼───────┐
                │   web :3001    │  Bun + React SPA, proxies /api/* to api
                └────────┬───────┘
                         │ /api/*
                ┌────────▼───────┐
                │   api :3000    │  Bun + @atlas/server (router), all routes
                └────┬───────┬───┘
                     │       │
            ┌────────▼───┐  ┌▼────────────┐
            │ Postgres   │  │ Spaces /    │
            │ (metadata) │  │ S3-compat   │
            └────────────┘  │ (blobs)     │
                            └─────────────┘
```

In production droplets, `compose.yaml` runs all four locally on the same host. In App Platform, Caddy is replaced by DO's edge.

## Code layout

```
src/
  server.ts         — composition root, Bun.serve + atlas router
  schema/index.ts   — TypeScript schema mirror for @atlas/db
  auth/             — signup / login / MFA challenge + sessions + JWT/PAT guard
  users/            — /me, profile, password change, account deletion
  folders/          — folder CRUD, soft-delete, photos kind, public toggle
  files/            — file CRUD, multipart upload, versioning, thumbnails
  shares/           — public share links (expiry, password, burn-on-view)
  collabs/          — folder + file collaborators (viewer / editor)
  trash/            — soft-deleted listing, restore, purge
  search/           — pg_trgm filename + filter-token search
  invites/          — invite-only signup tokens (per-user)
  waitlist/         — public invite request form
  public/           — public folder + public file routes (no auth)
  admin/            — owner-only: users, invites, audit, stats
  payments/         — Lemon Squeezy hosted checkout + webhook + admin config
  apps/             — personal access tokens (PATs) for SDKs / native apps
  oauth/            — OAuth 2.0 provider (auth code + PKCE, device flow, discovery)
  s3keys/           — sigv4 access keys for the S3-compatible API
  s3/               — S3-compatible endpoints with sigv4 verification
  security/         — TOTP, rate limits, audit log, sessions, security headers
  permissions/      — unified folder/file access resolver
  storage/          — only module that talks to @atlas/storage
  util/             — small helpers (token, username)
  web/              — single-file React SPA + serve.ts
migrations/         — hand-written SQL, applied at API startup via @atlas/migrate
scripts/deploy/     — DigitalOcean provisioning automation
sdks/               — official client libraries (TS, Dart, Swift, Kotlin)
apps/               — native clients (desktop menu-bar, mobile)
docs/               — what you're reading
```

## Request pipeline

`@atlas/server` uses **pipes** — small composable functions over a `Conn`. A typical handler:

```ts
const guard = pipeline(requireAuth({ secret, db }))
const authed = pipeline(requireAuth({ secret, db }), parseJson)

post("/folders", authed(async (c) => {
  const userId = c.assigns.auth.id
  const body = c.body as { name: string; parent_id?: number | null }
  // … handler logic
  return json(c, 201, row)
}))
```

`requireAuth` puts the verified caller on `c.assigns.auth`. It accepts three credential types:

- **JWT** — issued by `/login`, `/signup`, `/login/mfa`. Carries a `jti` checked against the `sessions` table on every request, so revocation is immediate.
- **PAT** — strings prefixed `stohr_pat_…`, minted via `POST /me/apps`. Stored as SHA-256 hashes; `last_used_at` updated on each call.
- **OAuth access token** — JWT issued by `/oauth/token`. Routes that mint further credentials (PATs, MFA, OAuth clients, password change, account deletion) opt out via `noOAuth: true`.

`parseJson` populates `c.body`. `pipeline()` halts on the first failure (e.g. missing token → 401).

## Permissions

A unified helper resolves access for both folders and files:

```
src/permissions/index.ts
  folderAccess(db, userId, folderId) → { role, folder } | null
  fileAccess(db, userId, fileId)     → { role, file }   | null
  canWrite(role)                     → role !== "viewer"
  isOwner(role)                      → role === "owner"
```

Roles: `owner` (the user the file/folder belongs to), `editor` (write), `viewer` (read-only). Folder grants cascade — if you're a viewer of `/photos`, you're a viewer of every file and subfolder underneath.

## Security middleware

`src/security/headers.ts` wraps the router and adds HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, and the COOP/CORP pair to every response.

Rate limiting is applied per-route via `checkRate` against the `rate_limits` table (sliding-bucket counters keyed by `<scope>:<key>`). Audit events (`audit_events` table) are emitted from auth, MFA, sessions, and password flows via `logEvent`.

## Storage

`src/storage/index.ts` is the only module that talks to `@atlas/storage`. Every blob is keyed `u<userId>/<timestamp><rand>/<sanitized-name>`. Deleting a file requires deleting the DB row **and** the storage object — purges and account-deletion always do both.

## SPA routing

`src/web/serve.ts` declares the routes Bun's HTML bundler should resolve to `index.html`:

```ts
"/": index, "/s/:token": index, "/signup": index, "/login": index,
"/app/*": index, "/p/:username/:folderId": index,
"/oauth/authorize": index, "/pair": index,
```

Inside the SPA, `parseRoute(window.location)` returns a discriminated `Route` union; the App component dispatches:

- `share` → public file share preview
- `publicFolder` → public photos viewer (no auth)
- `oauthAuthorize` → OAuth consent screen (calls `/oauth/authorize/info|approve|deny`)
- `pair` → OAuth device-flow pairing page
- otherwise → `Auth` (login/signup) or `Shell` (logged in)

## Background sweeps

Started from `src/server.ts` on a `setInterval`:

- Expired OAuth authorization codes (60s TTL) — every 5 min
- Expired OAuth device codes (10 min TTL) — every 5 min
- Expired OAuth refresh tokens (30 day TTL) — every hour
- Expired sessions — every hour (started from `sessionRoutes`)
- Expired share rows — every hour (started from `shareRoutes`)

All sweeps also run once at boot.
