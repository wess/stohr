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

### Object storage (any S3-compatible provider)

| var | default | purpose |
| --- | --- | --- |
| `S3_ENDPOINT` | `http://localhost:4000` | Provider endpoint (Spaces / MinIO / RustFS / B2 / S3) |
| `S3_BUCKET` | `stohr` | Bucket name |
| `S3_REGION` | `us-east-1` | Region used for SigV4 signing. Most providers accept any string, AWS does not |
| `S3_ACCESS_KEY` | `rustfsadmin` | Access key |
| `S3_SECRET_KEY` | `rustfsadmin` | Secret key |

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

### Security & deployment

| var | default | purpose |
| --- | --- | --- |
| `MAX_UPLOAD_BYTES` | `1073741824` (1 GiB) | Hard cap on a single request body. Bun buffers the body and `@atlas/storage` re-buffers it to compute SigV4 — this is effectively a per-upload memory ceiling |
| `TRUSTED_PROXIES` | (empty) | Comma-separated IPv4 addresses or CIDRs allowed to set `X-Forwarded-For` / `X-Real-IP`. With Docker Compose set this to `172.16.0.0/12` (covers the bridge). Leave empty for direct-to-API traffic. Untrusted XFF is ignored; the socket peer is used instead |

### Observability

| var | default | purpose |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | One of `debug`, `info`, `warn`, `error`. The API emits one JSON object per line — `info` and `debug` go to stdout, `warn` and `error` to stderr. Each log line includes `ts`, `level`, `msg`, and (for `http` lines) a `request_id` correlating to the `x-request-id` response header |

### Background jobs

The API runs a built-in dispatcher that reads from a `jobs` table — used by outbound webhook delivery and the trash auto-purge sweep. Multiple API processes can share the queue safely (claims use `FOR UPDATE SKIP LOCKED`).

| var | default | purpose |
| --- | --- | --- |
| `JOBS_TICK_MS` | `2000` | Dispatcher poll interval. Lower = faster pickup, higher = less DB load. Defaults are fine for most deployments |
| `TRASH_RETENTION_DAYS` | `30` | Files / folders soft-deleted longer than this are hard-deleted (with storage drops) by the hourly `trash.autopurge` job. Set to a large number to effectively disable |

### Compose-only

These are read by `compose.yaml` and aren't seen by the API directly.

| var | default | purpose |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | (empty) | Password for the bundled Postgres container |
| `DOMAIN` | (empty) | Public hostname Caddy serves on. Caddy auto-provisions Let's Encrypt when this is a real domain |

### Payments (not env vars)

Lemon Squeezy keys, plan variant IDs, webhook secret, and live/test mode live in the `payment_config` table and are configured via Admin → Payments. See [PAYMENTS.md](PAYMENTS.md).

## Email is required in production

Three flows depend on outbound email:

- **Invites** (Settings → Invites and Admin → Invite requests). Without email the invite link is only visible to the inviter at creation; the recipient never gets a notification.
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

On a fresh database, the first signup auto-bypasses the invite gate and is flagged `is_owner = true`. Subsequent signups require a valid invite token (mintable from Settings → Invites or by promoting an invite request in the Admin panel).

## Quotas

Per-user storage caps come from the `users.storage_quota_bytes` column, which is set by the tier-flip logic in `src/payments/index.ts` whenever a Lemon Squeezy webhook fires. Defaults:

- Free: 5 GB
- Personal: 50 GB
- Pro: 250 GB
- Studio: 1 TB

The cap is enforced at upload time (see `src/files/index.ts`) — an over-quota upload returns **402 Payment Required** with a JSON body `{ error, quota_bytes, used_bytes, attempted_bytes, breakdown }`. Concurrent uploads from the same user are rolled back if the post-write usage check exceeds quota.
