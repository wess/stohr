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
- `account_deletion.test.ts` — soft-delete, login during the 24h grace window, `/account/restore`, hard-delete sweep
- `discoverability.test.ts` — `/users/search` + `/u/:username` privacy, the `discoverable` toggle, `GET /me`
- `oauth.test.ts` — client registration, auth-code + PKCE flow, token endpoint, refresh rotation + reuse detection, scope guards, discovery
- `oauth_device.test.ts` — device authorize + polling lifecycle (RFC 8628), discovery
- `quotas.test.ts` — signup quota defaults, usage breakdown, `/me/usage`, admin-set storage caps
- `spaces.test.ts` — membership roles, space_id inheritance, no moves across spaces, a removed member keeps no access (files, shares, search, trash, WebDAV), space deletion covers descendants
- `folders.test.ts` — an editor cannot publish or retype a folder inside a shared folder
- `webdav.test.ts` — PROPFIND/PUT/GET/MKCOL, MOVE cycle and missing-parent rejection, quota (507), attachment + nosniff on GET, scan verdict reset on replace
- `uploads.test.ts` — chunked upload caps (total size, open sessions, reserved bytes), collaborator-owned sessions, quota re-check at finalize
- `s3gateway.test.ts` — SigV4 clock skew, credential date, body hash, infected refusal, quota rollback
- `filescan.test.ts` — re-upload and version restore reset the scan verdict
- `teams_hosts.test.ts` — slug rules, `parseHost`, `X-Forwarded-Host` trust, team urls, `withTeams` (unknown slug 404, suspended 403, foreign host = root)
- `teams_auth.test.ts` — a credential only works on its own team's host (JWT + PAT), `GET /me` team shape, login/password-reset/invite scoping, no open signup on a tenant host, root-only external login, per-host OAuth issuer
- `teams_admin.test.ts` — `/admin/teams` CRUD + reserved slugs + purge sweep, `/team/*` scoping (a team admin never reaches another team's users, last-admin rule), team quota cap, `/internal/tls/allow`
- `teams_hardening.test.ts` — the review follow-ups: uniqueness 409s sit behind the password / a per-admin budget and are audited, `root.<ROOT_DOMAIN>` is 404 with no certificate, `/internal/tls/allow` per-peer rate limit, deletion cancel links stay on the team host, `/team/audit` masks the owner as `Platform admin`, comments 404 when unseen, tenant invites are admin-only, the last-admin rule under concurrent demote/suspend/delete, `DELETE /admin/users/:id` drops blobs
- `limitbody.test.ts` — body caps, and that the rebuilt request keeps the `peerIp` / team stashes
- `helpers/multipart.ts` — `callMultipart` for the `POST /files` route (the in-memory `fakeStore` holds the bytes)
- `helpers/teams.ts` — `signupOwner`, `createTeam`, `teamWithAdmin`, `addMember`: a root owner, a team on `acme.stohr.test`, its admin signed in on that host

`buildApp(db, secret, { rootDomain })` turns host routing on for a file; `callJson` / `callRaw` / `callMultipart` take `host` (the `Host` header and url authority) and `peer` (the socket address `withSecurityHeaders` would stash). Without `rootDomain` every host is the root team, which is what the older files assume.

## What's deliberately not covered yet

- S3-backed chunked uploads (multipart against a real bucket; tests force `STORAGE_DRIVER=local`)
- Public folder + public file routes (some go through storage)
- Web UI (no React testing wired up)
- Mobile (`flutter test` lives separately under `apps/mobile/`)
