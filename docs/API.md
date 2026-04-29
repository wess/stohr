# REST API

All endpoints under `/api`. JSON in/out except where noted. Parameter names accept both `snake_case` (canonical) and `camelCase`.

## Auth

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/setup` | — | `{ needsSetup }` (true if zero users) |
| `POST` | `/signup` | `{ name, email, username, password, invite_token? }` | user + JWT |
| `POST` | `/login` | `{ identity, password }` (identity = email or username) | user + JWT, or `{ mfa_required, mfa_token }` |
| `POST` | `/login/mfa` | `{ mfa_token, code? \| backup_code? }` | user + JWT |

The first user — `needsSetup === true` — bypasses `invite_token` and is flagged `is_owner: true`. Login returns a 5-minute MFA challenge JWT when the account has TOTP enabled; finish via `/login/mfa`.

Login + signup are rate-limited per IP / per identity / per user (see [`SECURITY.md`](../SECURITY.md)).

## Account `/me` (auth required)

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/me` | — | full user |
| `PATCH` | `/me` | `{ name?, email?, username? }` | fresh user + new JWT (other sessions revoked) |
| `POST` | `/me/password` | `{ current_password, new_password }` | `{ ok, revoked_other_sessions }` |
| `DELETE` | `/me` | `{ password }` | account + files purged |
| `GET` | `/users/search?q=` | — | up to 10 user matches (excludes self) |
| `GET` | `/u/:username` | — | public user record |

Password change and account deletion reject OAuth access tokens — only first-party (web/mobile JWT or PAT) callers allowed.

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

Enable/disable revokes every other session for the user.

## Personal access tokens (auth required)

PATs (`stohr_pat_…`) are long-lived bearer tokens for SDKs and native apps. The full token is shown **once** at creation.

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/me/apps` | — | tokens (no secret value) |
| `POST` | `/me/apps` | `{ name, description? }` | `{ id, name, description, token_prefix, token, last_used_at, created_at }` |
| `DELETE` | `/me/apps/:id` | — | `{ revoked }` |

## Subscription / payments (auth required)

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/payments/plans` | — | public tier + price list |
| `GET` | `/me/subscription` | — | tier, quota, usage, renews_at |
| `POST` | `/me/checkout?tier=&period=` | — | `{ checkout_url }` (Lemon Squeezy hosted) |

`POST /lemonsqueezy/webhook` is the inbound webhook (HMAC-verified, no auth header).

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
| `GET` | `/files/:id/download` | streams the blob; add `?inline=1` for inline disposition |
| `GET` | `/files/:id/thumb` | streams the WebP thumbnail (images only); 404 if none |
| `POST` | `/files` | `multipart/form-data`, optional `folder_id` field |
| `PATCH` | `/files/:id` | `{ name?, folder_id? }` |
| `DELETE` | `/files/:id` | soft-delete |
| `POST` | `/files/:id/restore` | restore |
| `DELETE` | `/files/:id/purge` | permanent |
| `GET` | `/files/:id/versions` | current + archived |
| `GET` | `/files/:id/versions/:v/download` | specific version |
| `POST` | `/files/:id/versions/:v/restore` | promote to live |
| `DELETE` | `/files/:id/versions/:v` | delete archived |
| `GET/POST/DELETE` | `/files/:id/collaborators[/:cid]` | collaborator CRUD |

Re-uploading to the same `(folder, name)` archives the previous live version and increments `version`. Upload returns `402` if the new size would exceed the user's tier quota.

## Shares (auth required, except the `/s/:token` reads)

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/shares` | — | your active shares |
| `POST` | `/shares` | `{ file_id, expires_in?, password?, burn_after_view? }` | share |
| `DELETE` | `/shares/:id` | — | revoked |
| `GET` | `/s/:token` | — | streams blob (public, sets `Content-Disposition: attachment`; pass `?inline=1` to inline) |
| `GET` | `/s/:token?meta=1` | — | metadata for preview pages |

`expires_in` is required (max 30 days). Password-protected shares verify via the `X-Share-Password` header (or `?p=` query param). Burn-after-view shares atomically delete the row before serving — only one non-owner viewer wins.

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
| `GET` | `/invites` | invites the current user has minted |
| `POST` | `/invites` | `{ email? }` — bind to an email or leave open |
| `DELETE` | `/invites/:id` | revoke if unused |
| `GET` | `/invites/:token/check` | public — check if a token is valid |

## Invite requests (public)

`POST /invite-requests` with `{ email, name?, reason? }` — adds to the waitlist visible in Admin → Requests.

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
| `GET` | `/admin/invite-requests?status=` | list (`pending`/`invited`/`dismissed`) |
| `POST` | `/admin/invite-requests/:id/invite` | mint email-bound invite |
| `POST` | `/admin/invite-requests/:id/dismiss` | mark dismissed |
| `DELETE` | `/admin/invite-requests/:id` | hard delete |
| `GET` | `/admin/users` | all users + storage usage |
| `POST` | `/admin/users/:id/owner` | toggle is_owner |
| `DELETE` | `/admin/users/:id` | delete user (cascades) |
| `GET` | `/admin/invites?filter=` | system-wide invite list (`unused`/`used`/`all`) |
| `DELETE` | `/admin/invites/:id` | revoke unused |
| `GET` | `/admin/stats` | aggregate counts |
| `GET` | `/admin/audit?event=&user_id=&limit=` | audit event log (max 500 per call) |
| `GET/PUT` | `/admin/payments/config` | LS connection + plan IDs |
| `POST` | `/admin/payments/autosetup` | auto-detect store/products/variants |
| `GET` | `/admin/payments/subscriptions` | active subs |
| `POST` | `/admin/payments/users/:id/tier` | manual tier override |
| `GET` | `/admin/payments/events` | webhook event log |
| `GET` | `/admin/oauth/clients` | registered OAuth apps |
| `POST` | `/admin/oauth/clients` | register a new client (returns `client_secret` once if confidential) |
| `PATCH` | `/admin/oauth/clients/:id` | edit name / redirect URIs / scopes / `is_official` |
| `POST` | `/admin/oauth/clients/:id/rotate-secret` | issue a fresh `client_secret` |
| `DELETE` | `/admin/oauth/clients/:id` | revoke (existing tokens stop working) |

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
