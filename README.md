# Stohr

A self-hosted Box.net clone built on Atlas + Bun.

Upload files, organize them in folders, share them with public links. All functional, no classes, real implementations end-to-end.

## Features

- Email/password auth with JWT sessions (7-day tokens)
- Account management: profile edit, password change, account deletion
- Nested folders with breadcrumb navigation
- Drag-and-drop multi-file uploads
- File versioning — re-uploading a file with the same name in the same folder archives the previous version
- Soft-deleted trash with restore and purge
- Download, rename, move, delete files
- Public share links with optional expiry
- Cmd+K search palette across files and folders, with `type:` and `ext:` filter tokens, backed by Postgres `pg_trgm` trigram indexes
- Image thumbnails (JPEG, PNG, WebP, GIF) generated on upload via `sharp` and served as WebP
- S3-compatible object storage (works with [rustfs](https://rustfs.com), MinIO, AWS S3, etc.)

## Atlas packages used

`@atlas/config` · `@atlas/db` · `@atlas/migrate` · `@atlas/server` · `@atlas/auth` · `@atlas/storage` · `@atlas/cli`

## Run

Requires Bun, a reachable Postgres instance (the `pg_trgm` extension is enabled automatically by migration `00000007`), and an S3-compatible object store.

```bash
cp .env.example .env
bun install
bun run dev
```

- API: <http://localhost:3000>
- Web: <http://localhost:3001>

Migrations in `./migrations` run automatically on API startup.

## Environment

| var | default | purpose |
| --- | --- | --- |
| `PORT` | `3000` | API port |
| `WEB_PORT` | `3001` | Web/UI port |
| `API_URL` | `http://localhost:3000` | Where the web app proxies `/api/*` |
| `SECRET` | `dev-secret-change-me` | JWT signing secret |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/stohr` | Postgres connection string |
| `S3_ENDPOINT` | `http://localhost:4000` | S3-compatible endpoint |
| `S3_BUCKET` | `stohr` | Bucket name |
| `S3_REGION` | `us-east-1` | Bucket region |
| `S3_ACCESS_KEY` | `rustfsadmin` | Access key |
| `S3_SECRET_KEY` | `rustfsadmin` | Secret key |

## API

All request/response bodies are JSON unless noted. Parameter names accept both `snake_case` (shown below, used by the web client) and `camelCase`.

### Auth

- `POST /signup` — `{ name, email, password }` → `{ id, email, name, token }`
- `POST /login` — `{ email, password }` → `{ id, email, name, token }`

### Account (bearer required)

- `GET /me` — current profile
- `PATCH /me` — `{ name?, email? }` → profile + fresh `token`
- `POST /me/password` — `{ current_password, new_password }` (min 8 chars)
- `DELETE /me` — `{ password }` (permanently deletes account, files, and storage objects)

### Folders (bearer required)

- `GET /folders?parent_id=<id|null>`
- `GET /folders/:id` — folder with breadcrumb `trail`
- `POST /folders` — `{ name, parent_id? }`
- `PATCH /folders/:id` — `{ name?, parent_id? }` (move by setting `parent_id`; cannot move into self or own subtree)
- `DELETE /folders/:id` — soft delete (folder and descendants moved to trash)
- `POST /folders/:id/restore`
- `DELETE /folders/:id/purge` — permanent; drops files, versions, shares, and storage objects

### Files (bearer required)

- `GET /files?folder_id=<id|null>` or `GET /files?q=<search>`
- `GET /files/:id`
- `GET /files/:id/download` — add `?inline=1` for inline `Content-Disposition`
- `GET /files/:id/thumb` — streams the 256×256 WebP thumbnail (images only); `404` when no thumbnail exists. Cached `private, max-age=300`; UI should append `?v=<version>` to cache-bust across version changes.
- `POST /files` — `multipart/form-data`, optional `folder_id` field. Re-uploading a file with the same name in the same folder archives the previous version. For supported images (`image/jpeg|png|webp|gif`, under 25 MB) a thumbnail is generated synchronously; failures leave `thumb_key` null and do not block the upload.
- `PATCH /files/:id` — `{ name?, folder_id? }`
- `DELETE /files/:id` — soft delete
- `POST /files/:id/restore`
- `DELETE /files/:id/purge` — permanent; drops versions, shares, and storage objects

### Versions (bearer required)

- `GET /files/:id/versions` — current version plus archived history
- `GET /files/:id/versions/:version/download`
- `POST /files/:id/versions/:version/restore` — archives the current live blob, promotes `:version` to live, increments version counter
- `DELETE /files/:id/versions/:version` — permanently delete an archived version (cannot delete current)

### Trash (bearer required)

- `GET /trash` — soft-deleted folders and files for the current user
- `DELETE /trash` — empty trash (purges everything currently soft-deleted)

### Search (bearer required)

- `GET /search?q=<string>&limit=<n>` — returns `{ files, folders }` scoped to the current user, both arrays capped at `limit` (default 20, max 50).
- The `q` string is tokenized. Tokens of the form `type:<class>` filter files by mime class (`image | video | audio | document | text`); `ext:<name>` filters by trailing extension. All other tokens are joined into a name fragment matched against `files.name` and `folders.name` via `ILIKE`, with `%` and `_` escaped. Name matches are ranked by trigram similarity (`pg_trgm`).
- Filter-only queries (`type:image`, no name fragment) return matching files and an empty `folders` array. Fully empty queries return empty arrays.

### Shares (bearer required, except `/s/:token`)

- `GET /shares` — your active shares
- `POST /shares` — `{ file_id, expires_in? }` (seconds; omit for non-expiring)
- `DELETE /shares/:id`
- `GET /s/:token` — public download
- `GET /s/:token?meta=1` — public metadata (for the preview page)
