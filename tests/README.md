# Tests

Bun's built-in runner against an isolated `stohr_test` Postgres database.

## Prerequisites

- Postgres running locally with the same credentials as your dev DB. The test setup will:
  1. Probe `postgres://postgres:postgres@localhost:5432/stohr_test`
  2. If missing, connect to `postgres` and run `CREATE DATABASE stohr_test`
  3. Run all migrations from `./migrations/`

If your Postgres credentials differ, override at the shell:

```sh
TEST_ADMIN_URL=postgres://user:pw@host:5432/postgres \
TEST_DATABASE_URL=postgres://user:pw@host:5432/stohr_test \
bun test tests/
```

## Run everything

```sh
bun run test
```

## Run a single file

```sh
bun test tests/auth.test.ts
```

## Layout

- `setup.ts` — DB bootstrap, migrations, `truncateAll()`, shared `TEST_SECRET`
- `helpers/http.ts` — builds the same router `src/server.ts` does, calls it directly via `Request`/`Response` (no `Bun.serve`, no port). Storage is a stub since these tests focus on auth/session/share lifecycle, not bytes.
- `totp.test.ts` — RFC 6238 vectors, base32 round-trip, ±1 window, backup-code shape
- `ratelimit.test.ts` — bucket counter, window reset, retry-after
- `auth.test.ts` — signup, login, MFA challenge + verify, audit emission
- `sessions.test.ts` — JWT `jti` issuance, list/revoke/revoke-others, password-change cascade
- `shares.test.ts` — `expires_in` required + capped, password gate, expired auto-delete, burn-on-view atomic claim
- `apps.test.ts` — PAT mint, list (no token re-shown), authenticate, revoke

## What's deliberately not covered yet

- File upload route (multipart parsing + storage I/O — needs a real or mock S3)
- Public folder + public file routes (some go through storage)
- Web UI (no React testing wired up)
- Mobile (`flutter test` lives separately under `mobile/`)
