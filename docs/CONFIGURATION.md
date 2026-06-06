# Configuration

## Environment variables

`.env.example` is the source of truth. Copy to `.env` and edit. The list below mirrors that file plus a description of how each var is consumed.

### Core runtime

| var | default | purpose |
| --- | --- | --- |
| `PORT` | `3000` | API port |
| `WEB_PORT` | `3001` | Web/UI port |
| `API_URL` | `http://localhost:3000` | Where the web SPA proxies `/api/*` (must point at the API container in Docker) |
| `NODE_ENV` | `development` | Set to `production` to harden the API. With `production` the API refuses to start if `SECRET` is the default or shorter than 32 chars |
| `SECRET` | `dev-secret-change-me` | JWT + session signing key. **Must** be at least 32 chars in production. Generate with `openssl rand -hex 32` |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/stohr` | Postgres connection string |

### Blob storage

Stohr ships two storage drivers. All file CRUD always goes through the API regardless of which one is selected — clients never read or write the bucket / disk directly.

| var | default | purpose |
| --- | --- | --- |
| `STORAGE_DRIVER` | `s3` | Either `s3` (any S3-compatible provider) or `local` (disk-backed; single host only) |

#### `STORAGE_DRIVER=s3` — S3-compatible provider

| var | default | purpose |
| --- | --- | --- |
| `S3_ENDPOINT` | `http://localhost:4000` | Provider endpoint (Spaces / MinIO / RustFS / B2 / S3) |
| `S3_BUCKET` | `stohr` | Bucket name |
| `S3_REGION` | `us-east-1` | Region used for SigV4 signing. Most providers accept any string, AWS does not |
| `S3_ACCESS_KEY` | `rustfsadmin` | Access key |
| `S3_SECRET_KEY` | `rustfsadmin` | Secret key |

#### `STORAGE_DRIVER=local` — disk-backed (single-host)

| var | default | purpose |
| --- | --- | --- |
| `STORAGE_LOCAL_DIR` | `./.stohr/blobs` | Directory blobs are written to. Resolved relative to the API's working directory; **must** sit on a persistent volume in production. Not safe for multi-host deploys — point your replicas at the same shared filesystem (NFS, EFS, etc.) or use `s3` |

### Public URLs (must match what browsers see)

| var | default | purpose |
| --- | --- | --- |
| `APP_URL` | `http://localhost:3001` | Base URL for email links (invites, password reset, OAuth redirects). Always HTTPS in prod |

### Email (Resend)

| var | default | purpose |
| --- | --- | --- |
| `RESEND_API_KEY` | (empty) | API key. **Leave empty in dev** — emails print to the API console. **Required in prod**: invites, password reset, and collaboration emails silently fail without it |
| `RESEND_FROM` | `Stohr <onboarding@resend.dev>` | From-address. Must be a verified sender on your Resend account, or use the test sender |

### WebAuthn / passkeys

These three must be set together. A passkey created against one `RP_ID` cannot be used against another.

| var | default | purpose |
| --- | --- | --- |
| `RP_ID` | `localhost` | Relying-party ID — domain only, no port and no protocol (`stohr.io`, not `https://stohr.io:443`) |
| `RP_NAME` | `Stohr` | Display name shown in the OS-level passkey UI |
| `RP_ORIGIN` | `http://localhost:3001` | Full origin the SPA is served from. Must match what the browser sees |

### Social sign-in (OAuth consumer)

Stohr can let users sign in with Google (OpenID Connect) and GitHub (plain OAuth2). Each provider is **disabled unless both its `CLIENT_ID` and `CLIENT_SECRET` are set** — if either half is blank, that provider's routes return `404` and the SPA hides its button. Secrets live only in the environment; there is no DB-stored config or admin UI for them.

| var | default | purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | (empty) | Google OAuth client ID. Create at <https://console.cloud.google.com/apis/credentials>. Inert unless `GOOGLE_CLIENT_SECRET` is also set |
| `GOOGLE_CLIENT_SECRET` | (empty) | Google OAuth client secret. Inert unless `GOOGLE_CLIENT_ID` is also set |
| `GITHUB_CLIENT_ID` | (empty) | GitHub OAuth App client ID. Create at <https://github.com/settings/developers>. Inert unless `GITHUB_CLIENT_SECRET` is also set |
| `GITHUB_CLIENT_SECRET` | (empty) | GitHub OAuth App client secret. Inert unless `GITHUB_CLIENT_ID` is also set |
| `SOCIAL_AUTO_PROVISION` | `true` | When `true`, a new local user is created on first social login. Set to `false` (also accepts `0` / `no`) to require a pre-existing local account — no auto-provisioning |

**Callback / redirect URLs to register with each provider** (substitute your real `APP_URL` — your HTTPS web origin in production):

- Google — Authorized redirect URI: `<APP_URL>/api/auth/google/callback`
- GitHub — Authorization callback URL: `<APP_URL>/api/auth/github/callback`

The server builds these from `APP_URL`, so it must match the origin browsers actually hit or the provider will reject the redirect. The matching start endpoints are `<APP_URL>/api/auth/google/start` and `<APP_URL>/api/auth/github/start`.

### Federation

| var | default | purpose |
| --- | --- | --- |
| `FEDERATION_PUBLIC_URL` | (empty → falls back to `APP_URL`) | The URL other Stohr instances should hit for peer-to-peer traffic (invite acceptance, blob/shard PUT/GET/DELETE, drain re-replication). Set this only when peer traffic should enter on a different hostname than the user-facing web app |

The feature itself is toggled from **Admin → Settings** (`federation_enabled`), not via env. See [FEDERATION.md](FEDERATION.md).

### WebDAV

WebDAV has no env var on new deploys — it's an owner toggle (`webdav_enabled`) in **Admin → Settings**. See [WEBDAV.md](WEBDAV.md).

| var | default | purpose |
| --- | --- | --- |
| `WEBDAV_ENABLED` | (empty) | **Legacy / upgrade-only.** Pre-Admin-Settings releases gated WebDAV via this env var. The seed-on-first-boot path reads this once and writes `webdav_enabled=true` into the DB if it was previously `true`, so upgrades don't silently lose WebDAV. After upgrade, manage from Admin → Settings and ignore this var |

### Security & deployment

| var | default | purpose |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | `1073741824` (1 GiB) | Hard cap on a single request body. Bun buffers the body in memory; with `STORAGE_DRIVER=s3` the `@atlas/storage` driver re-buffers it to compute the SigV4 payload hash, so this is effectively a per-upload memory ceiling. The `local` driver streams to disk after Bun's initial buffer |
| `TRUSTED_PROXIES` | (empty) | Comma-separated IPv4 addresses or CIDRs allowed to set `X-Forwarded-For` / `X-Real-IP`. With Docker Compose set this to `172.16.0.0/12` (covers the bridge). Leave empty for direct-to-API traffic. Untrusted XFF is ignored; the socket peer is used instead |

### Antivirus scanning (ClamAV)

Uploads can be scanned for malware with a ClamAV daemon (`clamd`). The whole feature is keyed off `CLAMD_HOST`.

| var | default | purpose |
| --- | --- | --- |
| `CLAMD_HOST` | (empty) | Hostname of the `clamd` daemon. **When empty, scanning is disabled** — every upload is recorded with scan status `skipped` and is never gated. When set, new uploads are scanned (in the background sweep) and a download of a file that came back `infected` is blocked |
| `CLAMD_PORT` | `3310` | TCP port of the `clamd` daemon. Only used when `CLAMD_HOST` is set |

Behavior:

- **Disabled** (`CLAMD_HOST` empty): uploads succeed and the file's scan status is `skipped`. A `skipped` result never blocks an upload or a download, so existing deployments are unaffected.
- **Enabled** (`CLAMD_HOST` set): each new file is scanned via `clamd`; a download of a file flagged `infected` returns **403 Forbidden**. Files larger than clamd's 25 MB `INSTREAM` limit are recorded `skipped`. Point `CLAMD_HOST` only at a local / self-hosted `clamd` — never a third-party API — so file bytes never leave the host.

`compose.yaml` ships a commented-out `clamav` sidecar (`clamav/clamav:latest`, port `3310`). To enable it: uncomment that service, set `CLAMD_HOST=clamav` in your `.env` (`CLAMD_PORT` defaults to `3310`), and add `clamav` to the `api` service's `depends_on`.

### Observability

| var | default | purpose |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Structured-logging verbosity — one of `debug`, `info`, `warn`, `error`. Logs are emitted as one-line JSON to stdout; meta keys matching `password` / `secret` / `key` / `token` / `authorization` are auto-redacted. Read once at startup, so a change needs a process restart |

Three public, unauthenticated endpoints are exposed for orchestrators and scrapers (they exist before any credential does, so they never require auth):

- `GET /healthz` — liveness. Always `200 {"status":"alive"}` while the process is up; touches no dependencies.
- `GET /readyz` — readiness. Probes Postgres (`SELECT 1`) and the blob backend; `200 {"status":"ready",...}` when both pass, else `503`.
- `GET /metrics` — Prometheus exposition (`text/plain; version=0.0.4`): `http_requests_total` and `http_request_duration_ms` keyed by method + status. Metrics are per-process and in-memory (reset on restart) — scrape each replica.

### Compose-only

These are read by `compose.yaml` and aren't seen by the API directly.

| var | default | purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | (empty) | Password for the bundled Postgres container |
| `DOMAIN` | (empty) | Public hostname Caddy serves on. Caddy auto-provisions Let's Encrypt when this is a real domain |

## Email is required in production

Three flows depend on outbound email:

- **Invites** (Settings → Invites and Admin → Invites). Without email the invite link is only visible to the inviter at creation; the recipient never gets a notification.
- **Password reset** (`/password/forgot`). The reset link is only delivered by email.
- **Collaboration** (Sharing folders/files with someone by email). The recipient gets a one-click "join" email.

If `RESEND_API_KEY` is empty, Stohr boots fine — emails are written to the API container's stdout instead. Useful for local dev. **Don't ship that to prod.**

## WebAuthn requirements in production

- `RP_ID`, `RP_NAME`, `RP_ORIGIN` must all be set.
- `RP_ORIGIN` must be **HTTPS** in production. Browsers refuse passkey registration over HTTP except on `localhost`.
- `RP_ID` must match the eTLD+1 of `RP_ORIGIN`. Mixing `RP_ID=stohr.io` with `RP_ORIGIN=https://app.example.com` fails.
- Passkeys created against `RP_ID=localhost` will not work after you flip `RP_ID` to your real domain — users have to re-register.

## Database

Stohr migrates on startup via `@atlas/migrate`. The migrations directory is hand-written SQL with `up.sql` / `down.sql` per change set:

```
migrations/00000001_create_users/up.sql
migrations/00000002_create_folders/up.sql
…
migrations/00000031_perf_indexes/up.sql
migrations/00000032_invite_token_hash/up.sql
```

Schema is also mirrored in TypeScript in `src/schema/index.ts` for query-builder use, but the SQL files are authoritative at runtime.

The Postgres role used at runtime needs:

- `CREATE` on the database (for migrations to add tables / indexes)
- The ability to run `CREATE EXTENSION IF NOT EXISTS pgcrypto` and `pg_trgm` (managed providers like DigitalOcean, RDS, and Supabase allow this for normal users)

## Bun runtime tuning

`src/server.ts`:

- `maxRequestBodySize: config.maxUploadBytes` (default 1 GiB) — hard cap on a single request body
- `idleTimeout: 0` — connections never time out (needed for slow uploads)
- `hostname: "0.0.0.0"` — bind to all interfaces (for containers)

`src/web/serve.ts` reads `NODE_ENV` and only enables Bun's HMR-mode bundler when `development`. In production it bundles with the prod JSX runtime — required for the SPA to render.

## Storage

Spaces, MinIO, RustFS, AWS S3, and Backblaze B2 all work — anything that speaks the S3 API. The bucket is shared across all Stohr users; per-user objects are namespaced by user id in the storage key.

## Bootstrap flow

On a fresh database, the first signup auto-bypasses the invite gate and is flagged `is_owner = true`. Subsequent signups require a valid invite token (mintable from Settings → Invites or Admin → Invites).

## Quotas

Per-user storage caps live in the `users.storage_quota_bytes` column. It defaults to `0`, which means **unlimited**. The owner sets a cap for any user from **Admin → Users → Set quota** (`POST /admin/users/:id/quota`).

The cap is enforced at upload time (see `src/files/index.ts` and the S3-compatible API) — an over-quota upload returns **402 Payment Required** with a JSON body `{ error, quota_bytes, used_bytes, attempted_bytes, breakdown }`. Concurrent uploads from the same user are rolled back if the post-write usage check exceeds the cap.

## Other capabilities

No extra env vars beyond the core config above — listed here so the surface is discoverable. See [API.md](API.md) for request/response details.

- **Resumable uploads** — chunked, resumable upload sessions under `/files/upload/*` (`POST /files/upload/init`, `POST /files/upload/:id/chunk`, `GET /files/upload/:id/status`, `POST /files/upload/:id/finalize`, `DELETE /files/upload/:id`). Authenticated; honors the same per-user [quota](#quotas) up front and, when enabled, [antivirus scanning](#antivirus-scanning-clamav). Implemented in `src/uploads/`.
- **Per-user webhooks** — users register outbound webhooks under `/webhooks` (`GET`/`POST` `/webhooks`, `PATCH`/`DELETE` `/webhooks/:id`, `GET /webhooks/:id/deliveries`) to receive event callbacks; an optional per-hook signing secret is write-only. Implemented in `src/webhooks/`.
