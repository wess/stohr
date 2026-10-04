# Teams (multi-tenancy)

A **team** is a hard tenant boundary on one Stohr instance. Each client gets
their own team, reached on its own subdomain, with its own users, admins,
quota, and files. Teams cannot see, search, message, share with, or
collaborate with one another.

`storage.wess.dev` is the **root**: the instance owner's own team (slug
`root`) and the control plane for creating and managing every other team.
A client at `acme.storage.wess.dev` is team `acme`.

## Model

- `teams` table: `id`, `slug` (unique, DNS-label safe), `name`, `quota_bytes`
  (nullable = unlimited), `suspended_at`, `deleted_at`, `created_at`.
- Migration `00000059_teams` seeds team `1` = `root`. Every existing user
  moves into it.
- `users.team_id` NOT NULL references `teams`. A user belongs to exactly one team.
- `users.team_admin` boolean: manages their own team's users, invites and audit.
  The instance owner (`is_owner`, root team only) is the platform admin and can
  manage all teams. `ownerOnly` refuses `is_owner` on a non-root user.
- `invites.team_id` and `audit_events.team_id` scope those rows to a team.
  `logEvent` fills `team_id` from the actor's team when the caller does not
  pass one.
- Usernames and emails stay **globally unique** (public `/p/:username/...` URLs
  and existing lookups depend on it). A person needing two teams uses two emails.
- Slugs are lowercase DNS labels, 2–63 chars; a reserved list (`root`, `www`,
  `api`, `admin`, `app`, `mail`, `static`, `s3`, `webdav`, `mcp`, ...) is
  refused in code (`src/teams/slug.ts`). Reserved labels never resolve as a
  host either: `root.ROOT_DOMAIN` is 404, not a second name for the root
  team (`parseHost` calls it invalid and `teamBySlug` refuses it, so no
  certificate is issued for it). A soft-deleted team keeps its slug until
  the purge.

## Resolving the team

`ROOT_DOMAIN` (e.g. `storage.wess.dev`) turns host routing on. Unset = single
tenant, everything is the root team (existing behaviour, nothing changes).

Per request, from the effective host:

- host == `ROOT_DOMAIN`, or not under it (localhost, an IP, health checks) -> root team
- host == `<slug>.ROOT_DOMAIN` -> that team; unknown/deleted/reserved slug -> 404
- anything deeper (`a.b.ROOT_DOMAIN`) or malformed -> 404
- suspended team -> 403 on every route except the infra paths

The infra paths (`/healthz`, `/readyz`, `/metrics`, `/internal/tls/allow`)
skip resolution entirely — they must never touch the database — and see the
root team.

A user's team is also pinned to the host on the unauthenticated paths that
act on an account: the deletion cancel link (`/account/restore`) is mailed
with the team's base url and only matches a user of the host's team.

The effective host is `X-Forwarded-Host` (first hop) only when the socket
peer is in `TRUSTED_PROXIES` (same trust rule as the client IP), else `Host`.
The web proxy (`src/web/serve.ts`) always overwrites `x-forwarded-host` with
the browser's original `Host`.

In dev, `acme.localhost:3001` resolves to loopback in browsers, so
`ROOT_DOMAIN=localhost` works with no DNS.

Implementation: `withTeams(db, fetch, hosts)` in `src/teams/request.ts` wraps
the whole fetch handler (inside `withSecurityHeaders`, which stashes the
socket peer it needs) and stashes the resolved team on the `Request`;
`teamFor(req)` reads it back anywhere. Slug lookups go through a 30s
in-memory cache (misses included) that team writes clear. `limitBody`
rebuilds the `Request` for body routes and copies these stashes across.

## The rule that makes it isolation

**A credential only works on its own team's host.** `requireAuth` (JWT, PAT,
OAuth), WebDAV basic auth, S3 SigV4, and MCP all compare the authenticated
user's `team_id` to the host's team and return 401 on mismatch. A token minted
on `acme.` is useless on `root` or `other.`, and vice versa. `requireAuth`
puts `teamId`, `teamAdmin` and `isRoot` on `c.assigns.auth`.

Everything that reads other users must stay inside the caller's team: user
search/discovery, collaborator and space-member lookup by email/username,
messages, mentions, invites, share-to-user, notifications, activity, admin
user lists, audit, stats. Use the helpers in `src/teams/`: `teamIdOf`,
`sameTeam`, `userInTeam`, `inTeam(column, teamId)` (query-builder where) and
`usersInTeamSql(teamId)` (raw fragment).

Unauthenticated auth paths are scoped to the host's team too: `/login`,
`/login/mfa`, `/password/forgot`, `/password/reset` and passkey login only
match users of that team, with the same generic errors as a wrong password.
`/signup` on a tenant host requires an invite for that team (no self
bootstrap; only the root host ever creates a first owner). An invite carries
its `team_id` and redeems only on that team's host. On a tenant host only a
team admin mints invites (`POST /invites` is 403 for members; `/team/invites`
is admin-only anyway); on root any signed-in user still can, as before
teams. Adding a collaborator by an unregistered email (`/folders/:id/collaborators`)
still mails an invite from any member — that is a sharing flow, not an
open door, and the newcomer lands in the inviter's team.

Emails and usernames are unique across the whole instance, so any 409 from
a uniqueness check is a cross-team existence oracle. `PATCH /me` verifies
the current password (rate-limited) before it looks either up; the admin
edit and create paths bound those lookups per actor (30 per 15 minutes) and
log every conflict as `admin.identity_conflict`.

Public links (`/s/:token`, `/p/...`) are served only on the owner's team host.

## Root-only surfaces

Federation, instance settings (OIDC/LDAP/AI/WebDAV toggles), OAuth client
registration, contact-form review, instance stats, and `/admin/teams`.
External login (OIDC, LDAP, Google/GitHub, Castle SSO) exists on the root
host only — the routes are 404 elsewhere, the status endpoints report
unavailable, and the identity → user resolver only matches root-team
accounts. Tenant teams get password login and passkeys; no open signup
(team admins create users or invites).

## Admin API

- `POST /admin/teams` `{ slug, name, quota_bytes?, admin_email, admin_name?,
  admin_username? }` creates the team and its first team admin, returns a
  one-time set-password link on that team's host (`set_password_url`, also
  emailed when delivery is possible). Refused with 422 while `ROOT_DOMAIN`
  is unset.
- `GET /admin/teams?filter=live|deleted|all`, `GET /admin/teams/:id`
  (usage, user count, base_url)
- `PATCH /admin/teams/:id` (`name`, `quota_bytes` — `null`/`0` = unlimited,
  `suspended`); root cannot be suspended.
- `DELETE /admin/teams/:id` soft-deletes (host stops resolving at once);
  `POST /admin/teams/:id/restore` undoes it inside the window. A sweep
  purges users, files and blobs after the usual 24h grace, then the row.
- Team admins: `/team` (own usage/quota), `/team/users` (list, create,
  detail, edit incl. `team_admin`, suspend/unsuspend, reset-password,
  message, delete), `/team/invites`, `/team/audit`. Same shapes as the
  owner-only equivalents, scoped to the host's team. A team admin never sees
  or edits a user outside the team, cannot touch an owner, cannot set
  `is_owner`, and the last active admin of a team cannot be demoted,
  suspended or deleted — the count and the write happen together under the
  team row's lock (`unlessLastAdmin`, `src/teams/members.ts`), so two admins
  acting at once cannot remove each other past the last one. The owner is a
  team admin of root on the root host and counts as one for that rule.
- `/team/audit` shows the team's own trail. Events the instance owner
  logged against the team (a password reset from `/admin/users`, say) appear
  with the actor as `Platform admin` and `user_id`, `username`, `email`,
  `ip` and `user_agent` nulled: who the owner is, and where they acted
  from, belongs to root.

## Quota

Per-user quota still applies. A team's `quota_bytes` caps the sum of all its
users' usage; `checkQuota` enforces both and reports which cap was hit
(`scope: "user" | "team"`). `GET /team` and `/admin/teams` expose team usage.

## Edge (TLS + DNS)

Wildcard DNS `*.storage.wess.dev` to the host. Caddy issues certificates on
demand, asking the api container directly — `GET
http://api:3000/internal/tls/allow?domain=<host>` (loopback or
`TRUSTED_PROXIES` peers only, 60 asks a minute per peer; 200 only for
`ROOT_DOMAIN`, the `APP_URL` host, and live team subdomains) — so nobody can
burn certificates on arbitrary names. The route is unreachable from the
public hostname: the `caddyfile` answers `/api/internal/*` with 404 in both
site blocks and the web proxy (`src/web/serve.ts`) refuses the prefix
before it would forward anything. See `caddyfile` and
[DEPLOY.md](DEPLOY.md).

## Deliberate limits

- One team per user; no cross-team sharing, ever.
- Storage keys remain `u<userId>/...`; isolation is enforced at the API, and
  blobs stay on the shared bucket/disk.
- Passkeys use `ROOT_DOMAIN` itself as the RP ID (`RP_ID` defaults to it).
  It is a registrable suffix of every team host, so one ceremony works on
  any subdomain; the expected origin is the resolved team's base URL, never
  the raw `Host` header. Credentials are still looked up per user — and on
  passkey login only among the host team's users — so they do not cross teams.
