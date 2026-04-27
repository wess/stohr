# REST API

All endpoints under `/api`. JSON in/out except where noted. Parameter names accept both `snake_case` (canonical) and `camelCase`.

## Auth

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/setup` | — | `{ needsSetup }` (true if zero users) |
| `POST` | `/signup` | `{ name, email, username, password, invite_token? }` | user + JWT |
| `POST` | `/login` | `{ identity, password }` (identity = email or username) | user + JWT |

The first user — `needsSetup === true` — bypasses `invite_token` and is flagged `is_owner: true`.

## Account `/me` (auth required)

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/me` | — | full user |
| `PATCH` | `/me` | `{ name?, email?, username? }` | fresh user + new JWT |
| `POST` | `/me/password` | `{ current_password, new_password }` | `{ ok }` |
| `DELETE` | `/me` | `{ password }` | account + files purged |
| `GET` | `/me/subscription` | — | tier, quota, usage |
| `POST` | `/me/checkout?tier=&period=` | — | `{ checkout_url }` (Lemon Squeezy hosted) |
| `GET/POST/DELETE` | `/me/s3-keys[/:id]` | — | S3 access keys for the API |

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

`kind` values: `standard` (default), `photos`. Only owners can mutate `kind` or `is_public`.

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

Re-uploading to the same `(folder, name)` archives the previous live version and increments `version`. Upload returns 402 if the new size would exceed the user's tier quota.

## Shares (auth required, except the `/s/:token` reads)

| method | path | body | returns |
| --- | --- | --- | --- |
| `GET` | `/shares` | — | your active shares |
| `POST` | `/shares` | `{ file_id, expires_in? }` (seconds) | share |
| `DELETE` | `/shares/:id` | — | revoked |
| `GET` | `/s/:token` | — | streams blob (public, sets `Content-Disposition: attachment`; pass `?inline=1` to inline) |
| `GET` | `/s/:token?meta=1` | — | metadata for preview pages |

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

If `identity` is an email and no user has it, the response includes `invite_token` — paste `https://stohr.io/signup?invite=<token>` in the email you send.

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

## Admin (owner only)

All `/admin/*` routes require `auth.is_owner === true`.

| method | path | notes |
| --- | --- | --- |
| `GET` | `/admin/invite-requests` | list |
| `POST` | `/admin/invite-requests/:id/invite` | mint email-bound invite |
| `POST` | `/admin/invite-requests/:id/dismiss` | mark dismissed |
| `DELETE` | `/admin/invite-requests/:id` | hard delete |
| `GET` | `/admin/users` | all users + storage usage |
| `POST` | `/admin/users/:id/owner` | toggle is_owner |
| `DELETE` | `/admin/users/:id` | delete user (cascades) |
| `GET` | `/admin/invites` | system-wide invite list |
| `DELETE` | `/admin/invites/:id` | revoke unused |
| `GET` | `/admin/stats` | aggregate counts |
| `GET/PUT` | `/admin/payments/config` | LS connection + plan IDs |
| `POST` | `/admin/payments/autosetup` | auto-detect store/products/variants |
| `GET` | `/admin/payments/subscriptions` | active subs |
| `POST` | `/admin/payments/users/:id/tier` | manual tier override |
| `GET` | `/admin/payments/events` | webhook event log |

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
