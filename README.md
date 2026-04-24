# Stohr

A self-hosted Box.net clone built on Atlas + Bun.

Upload files, organize them in folders, share them with public links. All functional, no classes, real implementations end-to-end.

## Features

- Email/password auth with JWT sessions (7-day tokens)
- Nested folders with breadcrumb navigation
- Drag-and-drop multi-file uploads
- Download, rename, move, delete files
- Public share links with optional expiry
- Fuzzy name search across all your files
- Local disk storage (no S3 required)

## Atlas packages used

`@atlas/config` · `@atlas/db` · `@atlas/migrate` · `@atlas/server` · `@atlas/auth` · `@atlas/cli`

## Run

```bash
cp .env.example .env
bun install
bun run dev
```

- API: <http://localhost:3000>
- Web: <http://localhost:3001>

## Environment

| var | default | purpose |
| --- | --- | --- |
| `PORT` | `3000` | API port |
| `WEB_PORT` | `3001` | Web/UI port |
| `API_URL` | `http://localhost:3000` | Where the web app proxies `/api/*` |
| `SECRET` | `dev-secret-change-me` | JWT signing secret |
| `DB_PATH` | `./stohr.db` | SQLite file |
| `STORAGE_DIR` | `./storage/data` | Local file storage root |

## API

### Auth
- `POST /signup` — `{ name, email, password }` → `{ id, email, name, token }`
- `POST /login` — `{ email, password }` → `{ id, email, name, token }`

### Folders (bearer required)
- `GET /folders?parentId=<id|null>`
- `GET /folders/:id` — folder with breadcrumb `trail`
- `POST /folders` — `{ name, parentId? }`
- `PATCH /folders/:id` — `{ name }`
- `DELETE /folders/:id`

### Files (bearer required)
- `GET /files?folderId=<id|null>` or `GET /files?q=<search>`
- `GET /files/:id`
- `GET /files/:id/download`
- `POST /files` — multipart/form-data, optional `folderId` field
- `PATCH /files/:id` — `{ name?, folderId? }`
- `DELETE /files/:id`

### Shares (bearer required, except `/s/:token`)
- `GET /shares` — your active shares
- `POST /shares` — `{ fileId, expiresIn? }` (seconds)
- `DELETE /shares/:id`
- `GET /s/:token` — public download
- `GET /s/:token?meta=1` — public metadata (for the preview page)
