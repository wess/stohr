# Architecture

A high-level walk-through of what's running and how it fits together.

## Processes

```
                ┌────────────────┐
                │  Caddy :80/443 │  TLS, reverse proxy
                └────────┬───────┘
                         │
                ┌────────▼───────┐
                │   web :3001    │  Bun + React SPA, proxies /api/* to api
                └────────┬───────┘
                         │ /api/*
                ┌────────▼───────┐
                │   api :3000    │  Bun + @atlas/server (router), all routes
                └────┬───────┬───┘
                     │       │
            ┌────────▼───┐  ┌▼────────────┐
            │ Postgres   │  │ Spaces /    │
            │ (metadata) │  │ S3-compat   │
            └────────────┘  │ (blobs)     │
                            └─────────────┘
```

In production droplets, `compose.yaml` runs all four locally on the same host. In App Platform, Caddy is replaced by DO's edge.

## Code layout

```
src/
  server.ts        — composition root, Bun.serve + atlas router
  schema/index.ts  — TypeScript schema mirror for @atlas/db
  <feature>/index.ts — one file per resource, exports {feature}Routes(db, secret, store?)
  web/             — single-file React SPA + serve.ts
  s3/              — S3-compatible endpoints with sigv4
  payments/        — Lemon Squeezy webhook + admin config
  ...
migrations/        — hand-written SQL, applied at API startup via @atlas/migrate
scripts/deploy/    — DigitalOcean provisioning automation
sdks/              — official client libraries (TS, Dart, Swift, Kotlin)
docs/              — what you're reading
```

## Request pipeline

`@atlas/server` uses **pipes** — small composable functions over a `Conn`. A typical handler:

```ts
const guard = pipeline(requireAuth({ secret }))
const authed = pipeline(requireAuth({ secret }), parseJson)

post("/folders", authed(async (c) => {
  const userId = c.assigns.auth.id
  const body = c.body as { name: string; parent_id?: number | null }
  // … handler logic
  return json(c, 201, row)
}))
```

`requireAuth` puts the verified JWT payload on `c.assigns.auth`. `parseJson` populates `c.body`. `pipeline()` halts on the first failure (e.g. missing token → 401).

## Permissions

A unified helper resolves access for both folders and files:

```
src/permissions/index.ts
  folderAccess(db, userId, folderId) → { role, folder } | null
  fileAccess(db, userId, fileId)     → { role, file }   | null
  canWrite(role)                     → role !== "viewer"
  isOwner(role)                      → role === "owner"
```

Roles: `owner` (the user the file/folder belongs to), `editor` (write), `viewer` (read-only). Folder grants cascade — if you're a viewer of `/photos`, you're a viewer of every file and subfolder underneath.

## Storage

`src/storage/index.ts` is the only module that talks to `@atlas/storage`. Every blob is keyed `u<userId>/<timestamp><rand>/<sanitized-name>`. Deleting a file requires deleting the DB row **and** the storage object — purges and account-deletion always do both.

## SPA routing

`src/web/serve.ts` declares the routes Bun's HTML bundler should resolve to `index.html`:

```ts
"/": index, "/s/:token": index, "/signup": index, "/login": index,
"/app/*": index, "/p/:username/:folderId": index,
```

Inside the SPA, `parseRoute(window.location)` returns a discriminated `Route` union; the App component dispatches:

- `share` → public file share preview
- `publicFolder` → public photos viewer (no auth)
- otherwise → `Auth` (login/signup) or `Shell` (logged in)
