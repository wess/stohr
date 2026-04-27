# Configuration

## Environment variables

`.env.example` is the source of truth. Copy to `.env` and edit.

| var | default | purpose |
| --- | --- | --- |
| `PORT` | `3000` | API port |
| `WEB_PORT` | `3001` | Web/UI port |
| `API_URL` | `http://localhost:3000` | Where the web SPA proxies `/api/*` |
| `SECRET` | `dev-secret-change-me` | JWT signing secret. Must change in prod. |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/stohr` | Postgres connection string |
| `S3_ENDPOINT` | `http://localhost:4000` | S3-compatible blob store endpoint |
| `S3_BUCKET` | `stohr` | Bucket name |
| `S3_REGION` | `us-east-1` | Used for sigv4. Spaces accepts any value. |
| `S3_ACCESS_KEY` | `rustfsadmin` | Storage access key |
| `S3_SECRET_KEY` | `rustfsadmin` | Storage secret key |

Anything else (Lemon Squeezy keys, plan variant IDs, webhook secret) lives in the `payment_config` table and is configured via the Admin → Payments panel — not env vars.

## Database

Stohr migrates on startup via `@atlas/migrate`. The migrations directory is hand-written SQL with `up.sql` / `down.sql` per change set:

```
migrations/00000001_create_users/up.sql
migrations/00000002_create_folders/up.sql
…
migrations/00000016_s3_access_keys/up.sql
```

Schema is also mirrored in TypeScript in `src/schema/index.ts` for query-builder use, but the SQL files are authoritative at runtime.

## Bun runtime tuning

`src/server.ts` and `src/web/serve.ts` both pass:

- `maxRequestBodySize: Number.MAX_SAFE_INTEGER` — no upload limit
- `idleTimeout: 0` — connections never time out (needed for slow uploads)
- `hostname: "0.0.0.0"` — bind to all interfaces (for containers)

## Storage

Spaces, MinIO, RustFS, AWS S3, and Backblaze B2 all work — anything that speaks the S3 API. The bucket is shared across all stohr users; per-user objects are namespaced by user id in the storage key.

## Bootstrap flow

On a fresh database, the first signup auto-bypasses the invite gate and is flagged `is_owner = true`. Subsequent signups require a valid invite token (mintable from Settings → Invites or by promoting an invite request in the Admin panel).

## Quotas

Per-user storage caps come from the `users.storage_quota_bytes` column, which is set by the tier-flip logic in `src/payments/index.ts` whenever a Lemon Squeezy webhook fires. Defaults:

- Free: 5 GB
- Personal: 50 GB
- Pro: 250 GB
- Studio: 1 TB

The cap is enforced at upload time (see `src/files/index.ts`) — an over-quota upload returns **402 Payment Required** with a JSON body `{ error, quota_bytes, used_bytes, attempted_bytes }`.
