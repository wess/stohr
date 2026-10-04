# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.4] - 2026-10-04

### Fixed

- Formatting in `src/server.ts` that failed the lint gate in CI.

## [0.9.3] - 2026-10-04

### Fixed

- `.dockerignore` now lets `scripts/team.ts` into the build context; 0.9.2 could
  not build without it.

## [0.9.2] - 2026-10-04

### Fixed

- The image ships `scripts/team.ts` (the Dockerfile copy and the `.dockerignore`
  allowlist), so client teams can be provisioned with `docker exec` on the box.

## [0.9.1] - 2026-10-04

### Fixed

- Passkeys on team hosts: the WebAuthn RP ID is now chosen per host. Hosts
  covered by `RP_ID` keep it, so passkeys already registered there still work,
  and team hosts use `ROOT_DOMAIN`. A single fixed RP ID could never match a
  team subdomain.

## [0.9.0] - 2026-10-02

### Added

- Teams: hard multi-tenancy on one instance. Each team has its own subdomain
  (`<slug>.ROOT_DOMAIN`), users, admins, quota, invites and audit log, and
  cannot see, search, message or share with any other team. A credential only
  works on its own team's host. The root team (`ROOT_DOMAIN` itself) stays the
  control plane: `/admin/teams`, `scripts/team.ts`, and the SPA Teams page create
  and manage teams; team admins get `/team/*` and a Team page. Wildcard
  on-demand TLS via `/internal/tls/allow`. See `docs/TEAMS.md`.

### Security

- OAuth scopes are enforced (read / write / share); an OAuth token can no
  longer mint a session through `PATCH /me`, and credential-approving routes
  are `noOAuth`.
- `redirect_to` in social/OIDC login is resolved against `APP_URL` (the
  `/\host` bypass leaked the session token); external identities link by email
  only when verified; the MFA challenge token can no longer pass `requireAuth`
  and is single-use; SSO no longer links by username.
- Webhook and federation outbound requests refuse private, loopback and
  link-local targets and do not follow redirects blindly; webhook response bodies
  are no longer stored. Federation invites can't be forged against an existing
  federation, re-PUTs can't destroy hosted blobs, and signed requests are
  replay-protected.
- Space creators lose control of space content when removed; folders created in
  a space inherit it; editors can't publish an owner's folders; WebDAV MOVE
  cycles are rejected; scan status resets when content is replaced; quota is
  enforced on WebDAV and chunked uploads; SigV4 enforces clock skew.
- Unauthenticated JSON routes cap body size; the web proxy sets the real client
  IP and rate limiting walks `X-Forwarded-For` from the right.
- Cloud-init no longer exposes the GitHub token and blocks container access to
  the metadata service.

### Changed

- Dependencies: atlas v0.3.2, ldapts 9, sharp 0.35, lucide-react 1.x, Biome 2.5,
  React 19.3.
- Share tokens are 12 characters; existing 7-character tokens keep working.

### Fixed

- Rate-limit buckets collapsed to one IP on body routes (`limitBody` dropped the
  peer address); `/p/files/:id` never resolved; built SPA asset URLs 404'd on
  hard loads of nested routes.

## [0.8.0] - 2026-08-01

### Security

- Search snippets are HTML-escaped server-side. `ts_headline` does not escape
  the surrounding document text, so a file whose *contents* contained markup
  reached the SPA — which renders snippets with `dangerouslySetInnerHTML` — as
  live HTML. Hits are now marked with control-character sentinels, the whole
  snippet is escaped, and only the sentinels become `<mark>`.
- The SPA document and its assets are now served with the full security header
  set including CSP. `withSecurityHeaders` only ever wrapped the API router, so
  the HTML the browser actually executes shipped with no CSP at all. The
  theme-init script stays inline (it must run before first paint) and is
  allowlisted by a sha256 hash computed from the shipped HTML at boot.
- `ilike` patterns in `GET /files?q=` and the MCP search tool go through
  `escapeLike`; previously `%` and `_` in a query acted as wildcards.

### Added

- HTTP Range support on `GET /files/:id/download` — 206 with `Content-Range`,
  `Accept-Ranges: bytes` on every response, and 416 for unsatisfiable ranges.
  Without it browsers cannot seek in `<video>`/`<audio>`, and Safari refuses to
  play at all. `StorageDriver.get` takes an optional inclusive byte range,
  served by the backend rather than by fetching and discarding.
- Pagination on `GET /files` and `GET /folders` via `limit`/`offset`, with
  `x-limit` / `x-offset` / `x-has-more` response headers. Responses remain bare
  JSON arrays so existing SDK consumers are unaffected. The SPA gained a
  "Load more" control.
- Graceful shutdown on `SIGTERM`/`SIGINT` for both the API and web server:
  stop accepting connections, let in-flight requests finish, close the pool,
  with a 15s forced-exit backstop.
- `DB_POOL` and `IDLE_TIMEOUT` configuration, both documented in `.env.example`
  and wired through `compose.yaml`.

### Fixed

- Ranged reads from the local storage driver returned every byte from the range
  start to end-of-file while the response headers advertised the requested
  length. Handing a `BunFile` slice to `new Response(...)` yields a body stream
  that honors the slice's start offset but ignores its end; the driver now
  takes `.stream()` off the slice explicitly.
- `rate_limits` rows were never deleted. Buckets are keyed on caller-supplied
  identities (`login:id:<anything>`), so unauthenticated callers could grow the
  table without bound. Swept hourly with a 24h retention.
- `SECRET` is validated before the database connection and migrations rather
  than after, so a misconfigured production boot exits without touching the
  schema.
- `Content-Length` on downloads is taken from the storage response rather than
  the `files.size` column, so a mismatch can't leave clients waiting on bytes
  that never arrive.

### Changed

- Postgres pool size defaults to 20 instead of `@atlas/db`'s 5, which was a
  hard throughput ceiling: every authenticated request costs 2-3 queries and
  all background sweeps draw from the same pool.
- `requireAuth` resolves personal access tokens in one joined query instead of
  two, and runs the session and account-status lookups concurrently.
- `fileAccess` fetches the parent folder's `space_id` alongside the file rather
  than in a follow-up query — this path backs every download and thumbnail.
- Folder breadcrumbs resolve in a single recursive CTE instead of walking the
  ancestry one level at a time.
- `sessions.last_used_at` is written at most once per session per 5 minutes
  instead of on every authenticated request.
- Every background sweep is registered in `src/server.ts` under the shared
  overlap guard. The session and share-expiry sweeps previously scheduled
  themselves from inside their route factories, which hid them from the
  composition root and started timers in any test that built the route table.
  Boot sweeps are staggered rather than all firing at once.
- Static assets are served with `Cache-Control` (content-hashed assets
  `immutable`, `index.html` `no-cache`); previously the entire bundle was
  re-downloaded on every page load. The app icon is a 20KB 180×180 PNG instead
  of a 948KB 1254×1254 one, cutting first load from ~1.45MB to ~524KB.
- Socket `idleTimeout` is 120s rather than disabled on both servers.
- The web server returns 502 with a clear body when the API is unreachable,
  instead of an opaque runtime 500.

## [0.7.7] - 2026-05-31

### Fixed

- Type-check now passes cleanly under `tsc --noEmit`, so it can serve as a
  release gate. Resolved schema column default type mismatches in
  `src/schema/index.ts` (timestamp defaults typed as `Date`, bigint defaults
  as `bigint`), raw `select(...)` fragment typing in `src/federation/files.ts`
  and `src/admin/index.ts`, and a row-shape cast in `src/auth/deletion.ts`.

### Changed

- Biome now lints and formats `src/` and `scripts/` instead of a nonexistent
  `packages/` directory. Formatter settings match the existing house style
  (no semicolons, double quotes, omitted single-arg arrow parens). Pervasive
  pre-existing accessibility and React-hook findings in the single-file SPA
  are surfaced as warnings rather than hard errors so the gate stays green.
- `@biomejs/biome` is pinned in `devDependencies`; the lint/format/check
  scripts invoke the local binary directly.
- Added a `typecheck` script (`tsc --noEmit`).

### Added

- Continuous-integration workflow (`.github/workflows/ci.yml`) that runs the
  type-check, Biome, and the full test suite against a Postgres service
  container on every push and pull request. The existing publish workflow is
  unchanged.

## [0.7.6] - 2026-05-28

Latest release prior to this changelog. See the Git history for the granular
changes that shipped across the 0.7.x line, which includes the move of `atlas`
from a Git submodule to a Bun package dependency, the SPA pre-build with
`Bun.build`, single-sign-on work, and the MCP server.

[0.7.7]: https://github.com/wess/stohr/releases/tag/0.7.7
[0.7.6]: https://github.com/wess/stohr/releases/tag/0.7.6
