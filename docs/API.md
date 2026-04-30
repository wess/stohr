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
- **OAuth scopes** (when calling with an OAuth access token): `read` / `write` / `share`. Tokens that lack the required scope return 403 with `error: "Insufficient scope — '<needed>' is required, token has [<granted>]"`.

## Auth

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/setup` | — | `{ needsSetup }` (true if zero users) |
| `POST` | `/signup` | `{ name, email, username, password, invite_token? }` | user + JWT |
| `POST` | `/login` | `{ identity, password }` (identity = email or username) | user + JWT, or `{ mfa_required, mfa_token }` |
| `POST` | `/login/mfa` | `{ mfa_token, code? \| backup_code? }` | user + JWT |

The first user — `needsSetup === true` — bypasses `invite_token` and is flagged `is_owner: true`. Login returns a 5-minute MFA challenge JWT when the account has TOTP enabled; finish via `/login/mfa`.

Login + signup are rate-limited per IP / per identity / per user (see [`SECURITY.md`](../SECURITY.md)).

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

Re-uploading to the same `(folder, name)` archives the previous live version and increments `version`. Upload returns `402` if the new size would exceed the user's tier quota.

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

### Semantic search (optional)

When the operator has set `AI_EMBED_MODEL` and pulled the model, file contents are embedded in-process via `bai` and stored in `file_embeddings` (`pgvector` HNSW index). Two extra endpoints become useful:

| method | path | notes |
| --- | --- | --- |
| `GET` | `/search/semantic?q=&limit=` | Embeds `q` and returns up to `limit` files ranked by cosine similarity. Owner-only in v1 (collab-shared files are not yet returned). 503 if AI is disabled — clients should fall back to `/search` |
| `GET` | `/search/status` | `{ enabled, model, dim, reason }` — tells the client whether to offer semantic-search UI |

Each `/search/semantic` hit looks like:

```json
{
  "file_id": 42,
  "name": "RFC-stage1.md",
  "mime": "text/markdown",
  "size": 12_400,
  "folder_id": 7,
  "text_excerpt": "First ~1KB of the embedded text…",
  "score": 0.83
}
```

`score` is `1 - cosine_distance`, so 1.0 is identical and 0.0 is orthogonal. Embeddings are populated asynchronously by the `embeddings.generate` job — uploaded files become semantically searchable seconds after upload, not on the request itself. Only text-class mimes (`text/*`, JSON, XML, YAML, TOML, code) are embedded today; PDFs and Office docs remain filename-only.

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
| `POST` | `/invites` | `{ email? }` — bind to an email or leave open. Response includes `token` once; copy immediately |
| `DELETE` | `/invites/:id` | revoke if unused |
| `GET` | `/invites/:token/check` | public — check if a token is valid |

Tokens are stored as SHA-256 hashes; the plaintext is only ever returned in the response to the create call. List/admin views show metadata only.

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

## Webhooks (auth required, first-party only)

Outbound webhook subscriptions per user. Events fire whenever a file or folder you own is created, updated, or deleted, or whenever a share link you own is created or deleted. Events are **at-least-once** — receivers must dedupe on the `x-stohr-delivery` header.

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/me/webhooks` | — | list of your webhooks (no secrets) |
| `POST` | `/me/webhooks` | `{ url, events?: string[], description? }` | new webhook **with the secret returned once** — stash it; you can't read it back |
| `PATCH` | `/me/webhooks/:id` | `{ url?, events?, enabled?, description? }` | `{ id }` |
| `DELETE` | `/me/webhooks/:id` | — | `{ deleted }` |
| `POST` | `/me/webhooks/:id/rotate-secret` | — | `{ id, secret }` (new secret returned once) |
| `POST` | `/me/webhooks/:id/test` | — | `{ queued }` — enqueues a synthetic `ping` delivery |
| `GET` | `/me/webhooks/:id/deliveries` | — | last 100 attempts with status, response code, attempts, errors |

**Event filter syntax**: an empty array means "all events". Otherwise use exact matches (`file.created`) or wildcard prefixes (`file.*`).

**Available events**: `file.created`, `file.updated`, `file.deleted`, `folder.created`, `folder.updated`, `folder.deleted`, `share.created`, `share.deleted`, plus the synthetic `ping` from the test endpoint.

**Delivery semantics**:

- POST with `content-type: application/json`, body `{ event, delivered_at, data }`.
- 10s timeout. Any non-2xx or network failure triggers retry with exponential backoff (30s → 2m → 8m → 32m → 2h cap, up to 6 attempts). Then the delivery is marked dead.
- The job runner is shared with other background work; multi-process deployments coordinate via `FOR UPDATE SKIP LOCKED`.

**Headers your endpoint will receive**:

| header | value |
| --- | --- |
| `x-stohr-event` | event name, e.g. `file.created` |
| `x-stohr-delivery` | unique delivery id (use to dedupe) |
| `x-stohr-timestamp` | unix seconds at signing time |
| `x-stohr-signature` | `sha256=<hex>` HMAC over `${timestamp}.${body}` using your secret |

**Verifying a payload** (Node/Bun):

```ts
import { createHmac, timingSafeEqual } from "node:crypto"

const verify = (secret: string, ts: string, body: string, sig: string): boolean => {
  const mac = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")
  const expected = `sha256=${mac}`
  if (sig.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}
```

Reject any request where `Date.now()/1000 - Number(ts)` exceeds your tolerance window (5 minutes is typical) — that prevents replay.

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
| `GET` | `/admin/ai` | AI status + coverage: `{ enabled, model, dim, files_total, files_embedded, jobs_pending, jobs_dead }` |
| `POST` | `/admin/ai/backfill` | `{ force?: boolean, limit?: number }` — enqueue `embeddings.generate` jobs for files missing embeddings (or all files when `force=true`). Returns `{ enqueued, scanned, model, limit, force }`. 503 if AI is disabled |
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

## Health & readiness

Both endpoints are unauthenticated and unrate-limited. Skip `/api` — these are at the API root.

| method | path | notes |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness. `{ ok: true, uptime_s }`. Never touches the DB; safe to poll on a 1s interval |
| `GET` | `/readyz` | Readiness. `{ ok, checks: { db, storage } }` with per-check `ms` timing. Returns **503** if any dependency check fails. Point your load balancer at this |

Every API response carries an `x-request-id` header — the value of an inbound `x-request-id` is echoed if present, otherwise generated. The same id appears in the structured access log line for that request, so a 5xx report from a user is one grep away from the relevant logs.

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
