# REST API

All endpoints under `/api`. JSON in/out except where noted. Parameter names accept both `snake_case` (canonical) and `camelCase`.

## Conventions

- **Auth**: send `Authorization: Bearer <token>` for any route marked "auth required". A token is one of: a regular user JWT (web/mobile), a personal access token (`stohr_pat_…`), or an OAuth access token. Some routes refuse OAuth tokens — those are called out below.
- **Errors**: every non-2xx response has the shape `{ "error": "<message>" }`, sometimes with extra structured fields (`retry_after`, `quota_bytes`, etc.). The status codes Stohr uses:

  | status | meaning |
  | --- | --- |
  | 400 | malformed JSON / missing required field |
  | 401 | missing or invalid bearer token; bad credentials |
  | 402 | storage quota exceeded — `{ error, quota_bytes, used_bytes, attempted_bytes, breakdown }` |
  | 403 | authenticated but no permission for this resource |
  | 404 | resource doesn't exist or isn't visible to you |
  | 409 | conflict (e.g. email already in use, invite already used) |
  | 410 | resource gone (expired share token) |
  | 422 | validation error |
  | 429 | rate-limited — `{ error, retry_after }` (seconds until you can retry) |
  | 500 | unexpected server error |

- **Rate limits**: see [SECURITY.md](../SECURITY.md#rate-limiting) for the per-bucket numbers. The 429 body always includes `retry_after`.
- **OAuth scopes** (when calling with an OAuth access token): `read` / `write` / `share`. The guard derives the scope a request needs: `GET` / `HEAD` need `read`, anything under `/shares` needs `share`, every other method needs `write`. Tokens that lack it return 403 with `error: "Insufficient scope — '<needed>' is required, token has [<granted>]"`. Session JWTs and PATs are not scope-checked.

## Auth

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/setup` | — | `{ needsSetup }` (true if zero users; always false on a team host) |
| `POST` | `/signup` | `{ name, email, username, password, invite_token? }` | user + JWT |
| `POST` | `/login` | `{ identity, password }` (identity = email or username) | user + JWT, or `{ mfa_required, mfa_token }` |
| `POST` | `/login/mfa` | `{ mfa_token, code? \| backup_code? }` | user + JWT |

The first user — `needsSetup === true` — bypasses `invite_token` and is flagged `is_owner: true`. Login returns a 5-minute MFA challenge JWT when the account has TOTP enabled; finish via `/login/mfa`. The challenge is single-use (its `jti` is consumed on success) and is not a bearer credential — presenting it as `Authorization: Bearer` returns 401.

Pending collaborator invites addressed to the signup email are attached to the new account only when `invite_token` was itself bound to that email (i.e. was mailed there); a typed-in address proves nothing.

Login + signup are rate-limited per IP / per identity / per user (see [`SECURITY.md`](../SECURITY.md)).

With `ROOT_DOMAIN` set ([TEAMS.md](TEAMS.md)), every route is served for the team the request host resolves to: an unknown subdomain is `404 {"error":"Unknown team"}`, a suspended team `403`. Login, MFA, password reset, passkey login and invites only match that team's users; a credential issued on one team's host is `401` on any other. Signup on a team host requires an invite for that team.

## Password reset

| method | path | body | returns |
| --- | --- | --- | --- |
| `POST` | `/password/forgot` | `{ email }` | always `{ ok: true, message }` (does not reveal whether the email is on file) |
| `POST` | `/password/reset` | `{ token, new_password }` | `{ ok: true }` (token consumed; all sessions revoked) |

The reset token is a `stohr_pwr_…` value delivered by email. 1-hour TTL, single-use. Per-email and per-IP rate-limited. The token in the email URL is the only handle — query-string interception in Referer is mitigated by the global `Referrer-Policy: strict-origin-when-cross-origin` and by the reset-page being on Stohr's own origin.

## Passkeys / WebAuthn

Passkeys can be used for either passwordless login (discoverable credentials) or as a stronger second factor.

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/me/passkeys` | — | list of registered credentials (id, name, transports, last_used_at, created_at) |
| `POST` | `/me/passkeys/register/start` | — | WebAuthn `PublicKeyCredentialCreationOptions`; client passes to `navigator.credentials.create()` |
| `POST` | `/me/passkeys/register/finish` | `{ name?, response: <browser response> }` | the new credential row |
| `PATCH` | `/me/passkeys/:id` | `{ name }` | `{ ok }` |
| `DELETE` | `/me/passkeys/:id` | — | `{ deleted }` |
| `POST` | `/login/passkey/discover/start` | — | `PublicKeyCredentialRequestOptions` for `navigator.credentials.get()` |
| `POST` | `/login/passkey/discover/finish` | `{ response: <browser response> }` | user + JWT (no password required) |

Server validates origin, RP ID, signature, and counter regression. Challenges live in `webauthn_challenges` with a 5-minute TTL.

## Account `/me` (auth required)

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/me` | — | full user plus `team: { id, slug, name }`, `team_admin`, `is_root` |
| `PATCH` | `/me` | `{ name?, email?, username?, discoverable?, current_password? }` | fresh user; `token` (new JWT) only for session callers when name/email/username changed (other sessions revoked) |
| `POST` | `/me/password` | `{ current_password, new_password }` | `{ ok, revoked_other_sessions }` |
| `DELETE` | `/me` | `{ password }` | account + files purged |
| `GET` | `/users/search?q=` | — | up to 10 user matches (excludes self) |
| `GET` | `/u/:username` | — | public user record |

Profile changes, password change and account deletion reject OAuth access tokens — only first-party (web/mobile JWT or PAT) callers allowed. Changing `email` or `username` requires `current_password` (422 without it, 401 if wrong; rate-limited 10 / 15 min per user). A PAT caller never receives a `token` — the browser sessions are revoked and the PAT keeps working.

## Sessions (auth required)

| method | path | notes |
| --- | --- | --- |
| `GET` | `/me/sessions` | active session list with `current` flag |
| `DELETE` | `/me/sessions/:jti` | revoke one |
| `POST` | `/me/sessions/revoke-others` | revoke every session except this one |

PATs and OAuth tokens cannot reach these routes — only first-party JWTs.

## MFA / TOTP (auth required)

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/me/mfa` | — | `{ enabled, enabled_at, backup_codes_remaining }` |
| `POST` | `/me/mfa/setup` | — | `{ secret, otpauth_url }` (show as QR; not yet enabled) |
| `POST` | `/me/mfa/enable` | `{ code }` | `{ ok, backup_codes }` (10 single-use codes) |
| `POST` | `/me/mfa/disable` | `{ password, code }` | `{ ok }` |
| `POST` | `/me/mfa/backup-codes` | `{ password }` | `{ backup_codes }` (regenerated; old set invalidated) |

Enable/disable revokes every other session for the user. `disable` and `backup-codes` verify the password and are rate-limited (10 / 15 min per user) like `/me/password`.

## Personal access tokens (auth required)

PATs (`stohr_pat_…`) are long-lived bearer tokens for SDKs and native apps. The full token is shown **once** at creation.

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/me/apps` | — | tokens (no secret value) |
| `POST` | `/me/apps` | `{ name, description? }` | `{ id, name, description, token_prefix, token, last_used_at, created_at }` |
| `DELETE` | `/me/apps/:id` | — | `{ revoked }` |

## Storage usage (auth required)

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/me/usage` | — | storage usage + the per-user cap: `{ quota_bytes, used_bytes, active_bytes, trash_bytes, version_bytes }` (`quota_bytes: 0` = unlimited) |

## S3 access keys (auth required)

| method | path | notes |
| --- | --- | --- |
| `GET` | `/me/s3-keys` | list (no secret) |
| `POST` | `/me/s3-keys` | mint; `secret_key` returned **once** |
| `DELETE` | `/me/s3-keys/:id` | revoke |

See [S3.md](S3.md) for using the keys.

## Folders (auth required)

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/folders?parent_id=<id\|null>` | — | folder list |
| `GET` | `/folders/:id` | — | folder + breadcrumb `trail` + role + owner |
| `POST` | `/folders` | `{ name, parent_id?, kind?, is_public? }` | folder |
| `PATCH` | `/folders/:id` | `{ name?, parent_id?, kind?, is_public? }` | updated |
| `DELETE` | `/folders/:id` | — | soft-delete |
| `POST` | `/folders/:id/restore` | — | restore from trash |
| `DELETE` | `/folders/:id/purge` | — | permanent delete |
| `GET/POST/DELETE` | `/folders/:id/collaborators[/:cid]` | — | collaborator CRUD |

`kind` values: `standard` (default), `photos`, `screenshots`. Only owners can mutate `kind` or `is_public`.

## Files (auth required)

| method | path | notes |
| --- | --- | --- |
| `GET` | `/files?folder_id=<id\|null>` or `?q=<search>` | list / search |
| `GET` | `/files/:id` | metadata |
| `GET` | `/files/:id/download` | streams the blob; add `?inline=1` for inline disposition (only honored for `image/*`, `video/*`, `audio/*`, `application/pdf`, `text/plain` — anything else is forced to attachment) |
| `GET` | `/files/:id/thumb` | streams the WebP thumbnail (images only); 404 if none |
| `POST` | `/files` | `multipart/form-data`, optional `folder_id` field |
| `PATCH` | `/files/:id` | `{ name?, folder_id? }` |
| `DELETE` | `/files/:id` | soft-delete |
| `POST` | `/files/:id/restore` | restore |
| `DELETE` | `/files/:id/purge` | permanent |
| `GET` | `/files/:id/versions?limit=&offset=` | paginated `{ items, total, limit, offset }` — current + archived |
| `GET` | `/files/:id/versions/:v/download` | specific version |
| `POST` | `/files/:id/versions/:v/restore` | promote to live |
| `DELETE` | `/files/:id/versions/:v` | delete archived |
| `GET/POST/DELETE` | `/files/:id/collaborators[/:cid]` | collaborator CRUD |

Re-uploading to the same `(folder, name)` archives the previous live version and increments `version`. Upload returns `402` if the new size would exceed the user's storage quota.

## Shares (auth required, except the `/s/:token` reads)

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/shares` | — | your active shares |
| `POST` | `/shares` | `{ file_id, expires_in?, password?, burn_after_view? }` | share |
| `DELETE` | `/shares/:id` | — | revoked |
| `GET` | `/s/:token` | — | streams blob (public, sets `Content-Disposition: attachment`; pass `?inline=1` to inline) |
| `GET` | `/s/:token?meta=1` | — | metadata for preview pages |

`expires_in` is required (max 30 days). Password-protected shares verify via the `X-Share-Password` request header — query-string passwords (`?p=`) are **not** accepted. The inline `Content-Type` is restricted to a safe-MIME allowlist (images, video, audio, PDF, plain text); anything else is forced to `application/octet-stream` + `Content-Disposition: attachment`. Burn-after-view shares atomically delete the row before serving — only one non-owner viewer wins.

## Trash (auth required)

| method | path | notes |
| --- | --- | --- |
| `GET` | `/trash` | files + folders where `deleted_at IS NOT NULL` |
| `DELETE` | `/trash` | empty trash (purges everything in one cascade) |

Per-row restore / purge live on `/files/:id` and `/folders/:id` (see above).

## Public folders (no auth)

Toggling `is_public` on a folder publishes it at `/p/:owner/:folderId`:

| method | path | returns |
| --- | --- | --- |
| `GET` | `/p/:username/:folderId` | folder + owner + file list |
| `GET` | `/p/files/:id` | streams blob (only if file's folder is public) |
| `GET` | `/p/files/:id/thumb` | streams thumbnail |

## Search (auth required)

`GET /search?q=<query>&limit=<n>` returns `{ files, folders }` ranked by `pg_trgm` similarity.

The `q` string is tokenized:
- `type:image|video|audio|document|text` filters by mime class
- `ext:pdf` filters by extension
- everything else joins into a name fragment (case-insensitive `ILIKE`, `%` and `_` escaped)

## Collaborations

Folder/file collaborators are added by username or email:

```
POST /folders/:id/collaborators
{ "identity": "alice@example.com", "role": "editor" }
```

If `identity` is an email and no user has it, the response includes `invite_token` — paste `https://stohr.io/signup?invite=<token>` in the email you send. Pending email invites auto-resolve into real collaborators when that user signs up.

`GET /shared` returns folders + files directly shared with the current user.

## Invites (auth required)

| method | path | notes |
| --- | --- | --- |
| `GET` | `/invites` | invites the current user has minted (no plaintext token returned) |
| `POST` | `/invites` | `{ email? }` — bind to an email or leave open. Response includes `token` once; copy immediately. On a tenant host (`ROOT_DOMAIN` set, not the root team) only a `team_admin` may call this: 403 otherwise |
| `DELETE` | `/invites/:id` | revoke if unused |
| `GET` | `/invites/:token/check` | public — check if a token is valid |

Tokens are stored as SHA-256 hashes; the plaintext is only ever returned in the response to the create call. List/admin views show metadata only. An invite is bound to the minter's team and redeems on that team's host only.

## Action folders

See [ACTIONS.md](ACTIONS.md) for the model, event list, and how to write a built-in.

| method | path | notes |
| --- | --- | --- |
| `GET` | `/actions/registry` | public list of available actions + their `configSchema` |
| `GET` | `/folders/:id/actions` | actions attached to this folder |
| `POST` | `/folders/:id/actions` | `{ event, slug, config?, enabled? }` (owner only) |
| `PATCH` | `/folders/:id/actions/:aid` | `{ event?, config?, enabled? }` (owner only) |
| `DELETE` | `/folders/:id/actions/:aid` | (owner only) |
| `GET` | `/folders/:id/actions/runs?limit=` | recent runs for this folder (default 50, max 200) |

When an action fires during a request (e.g. a `POST /files` upload into an action folder), the matching run summaries are appended to each result entry as `action_results`.

## OAuth 2.0

See [OAUTH.md](OAUTH.md) for the full flow walk-through.

User-facing endpoints:

| method | path | notes |
| --- | --- | --- |
| `GET` | `/.well-known/oauth-authorization-server` | RFC 8414 discovery |
| `GET` | `/oauth/authorize/info` | (auth required) info for the consent screen |
| `POST` | `/oauth/authorize/approve` | (auth required) issue auth code |
| `POST` | `/oauth/authorize/deny` | (auth required) reject |
| `POST` | `/oauth/device/authorize` | start device flow (RFC 8628) |
| `GET` | `/oauth/device/info` | (auth required) device-code lookup |
| `POST` | `/oauth/device/approve` | (auth required) approve a device code |
| `POST` | `/oauth/device/deny` | (auth required) deny a device code |
| `POST` | `/oauth/token` | code → tokens, refresh, device → tokens |
| `POST` | `/oauth/revoke` | revoke a refresh token |

## Admin (owner only)

All `/admin/*` routes require `auth.is_owner === true`.

| method | path | notes |
| --- | --- | --- |
| `GET` | `/admin/users` | all users (every team) + storage usage, `team_id`, `team_admin` |
| `POST` | `/admin/users/:id/owner` | toggle is_owner (root team users only) |
| `POST` | `/admin/users/:id/quota` | set a per-user storage cap in bytes (0 = unlimited) |
| `DELETE` | `/admin/users/:id` | immediate hard delete: rows cascade, blobs and staged uploads are dropped (same path as `/team/users/:id`). 422 for yourself or a tenant team's last active admin |
| `GET` | `/admin/invites?filter=` | system-wide invite list (`unused`/`used`/`all`) |
| `DELETE` | `/admin/invites/:id` | revoke unused |
| `GET` | `/admin/stats` | aggregate counts |
| `GET` | `/admin/audit?event=&user_id=&limit=` | audit event log (max 500 per call) |
| `GET` | `/admin/oauth/clients` | registered OAuth apps |
| `POST` | `/admin/oauth/clients` | register a new client (returns `client_secret` once if confidential) |
| `PATCH` | `/admin/oauth/clients/:id` | edit name / redirect URIs / scopes / `is_official` |
| `POST` | `/admin/oauth/clients/:id/rotate-secret` | issue a fresh `client_secret` |
| `DELETE` | `/admin/oauth/clients/:id` | revoke (existing tokens stop working) |

### Teams (owner only, root host)

See [TEAMS.md](TEAMS.md). `quota_bytes` `null` or `0` means unlimited.

| method | path | body | notes |
| --- | --- | --- | --- |
| `GET` | `/admin/teams?filter=live\|deleted\|all` | — | teams with `usage`, `user_count`, `base_url` |
| `POST` | `/admin/teams` | `{ slug, name?, quota_bytes?, admin_email, admin_name?, admin_username? }` | creates the team + its first admin; returns `{ team, admin, set_password_url, emailed }`. 422 for a reserved/malformed slug or while `ROOT_DOMAIN` is unset, 409 for a taken slug or email |
| `GET` | `/admin/teams/:id` | — | one team with stats |
| `PATCH` | `/admin/teams/:id` | `{ name?, quota_bytes?, suspended? }` | root cannot be suspended |
| `DELETE` | `/admin/teams/:id` | — | soft delete; purged with users, files and blobs after 24h |
| `POST` | `/admin/teams/:id/restore` | — | undo inside the window |

## Team admin (`team_admin`, own team's host)

The owner-only user tools, pinned to the team the request host resolves to. The instance owner passes on the root host. A team admin cannot see users of other teams (404), cannot touch an owner, cannot set `is_owner`, and the last active admin of a team cannot be demoted, suspended or deleted.

| method | path | body | notes |
| --- | --- | --- | --- |
| `GET` | `/team` | — | own team: `quota_bytes`, `usage`, `user_count`, `base_url` |
| `GET` | `/team/users` | — | members + storage usage |
| `POST` | `/team/users` | `{ email, name?, username?, password?, team_admin? }` | creates a member; without `password` returns `set_password_url` (one-time link on this host, also emailed). Shares the 30-per-15-min identity budget with `PATCH` |
| `GET` | `/team/users/:id` | — | same shape as `/admin/users/:id` |
| `PATCH` | `/team/users/:id` | `{ name?, email?, username?, team_admin? }` | email/username changes are limited to 30 per 15 min per admin (429); a 409 is logged as `admin.identity_conflict` |
| `POST` | `/team/users/:id/suspend` | `{ reason? }` | revokes sessions |
| `POST` | `/team/users/:id/unsuspend` | — | |
| `POST` | `/team/users/:id/reset-password` | — | `{ emailed, reset_url }` as the admin route |
| `POST` | `/team/users/:id/message` | `{ subject, body }` | system message |
| `DELETE` | `/team/users/:id` | — | immediate hard delete, blobs dropped |
| `GET` | `/team/invites?filter=` | — | this team's invites |
| `POST` | `/team/invites` | `{ email? }` | invite bound to this team; token returned once |
| `DELETE` | `/team/invites/:id` | — | revoke unused |
| `GET` | `/team/audit?event=&user_id=&limit=` | — | this team's audit events; rows the instance owner logged against the team carry `actor: "Platform admin"` with `user_id`, `username`, `user_email`, `ip`, `user_agent` nulled |

## S3-compatible (sigv4 auth)

See [S3.md](S3.md) — entirely separate auth path using `s3_access_keys` rows.

| method | path | notes |
| --- | --- | --- |
| `PUT` | `/s3/:bucket/<key>` | upload |
| `GET` | `/s3/:bucket/<key>` | download |
| `GET` | `/s3/:bucket?prefix=<p>` | list objects |
| `HEAD` | `/s3/:bucket/<key>` | metadata |
| `DELETE` | `/s3/:bucket/<key>` | remove |

`bucket` = your username; `key` = slash-separated stohr file path.
