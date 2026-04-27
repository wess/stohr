# Stohr SDKs

Official client libraries for the [Stohr](https://stohr.io) cloud-storage API.

| Language     | Path             | Targets                       | Status |
|--------------|------------------|-------------------------------|--------|
| TypeScript   | `typescript/`    | Bun, Deno, Node 20+, browsers | ✓      |
| Dart         | `dart/`          | Flutter, Dart 3+              | ✓      |
| Swift        | `swift/`         | iOS 15+, macOS 12+            | ✓      |
| Kotlin       | `kotlin/`        | Android, JVM                  | ✓      |

All four wrap the same REST API (`https://stohr.io/api`) and expose the same
operations, named idiomatically per language.

## Common API surface

```
auth     login(identity, password)            → { token, user }
         signup({...invite_token, ...})       → { token, user }

me       get()                                → User
         update(patch)                        → User
         subscription()                       → Subscription
         changePassword(current, next)

folders  list(parentId?)                      → Folder[]
         get(id)                              → FolderDetail
         create(name, parentId?)              → Folder
         rename(id, name)
         move(id, parentId?)
         delete(id)

files    list(folderId?, q?)                  → File[]
         get(id)                              → File
         upload(blob, name, folderId?)        → File
         download(id)                         → Bytes/Stream
         thumbnail(id)                        → Bytes/Stream
         rename(id, name)
         move(id, folderId?)
         delete(id)
         versions(id)                         → Version[]

shares   list()                               → Share[]
         create(fileId, expiresIn?)           → Share
         delete(id)

collabs  add(kind, id, identity, role)
         list(kind, id)                       → Collaborator[]
         remove(kind, id, collabId)

shared   listSharedWithMe()                   → SharedItems

invites  list()                               → Invite[]
         create(email?)                       → Invite
         revoke(id)
```

## S3-compatible alternative

If you'd rather use existing S3 tooling (`aws-cli`, `boto3`, `aws-sdk`),
Stohr exposes a Sigv4-authenticated S3 endpoint at
`https://stohr.io/s3/<bucket>/<key>` where `bucket` is your username and
`key` is a slash-separated file path inside your storage. Mint S3 access
keys via `POST /api/me/s3-keys` and configure your S3 client to use them.
See the root `README.md` for full details.

## Versioning

All SDKs target API version `v1`. Breaking changes will bump the SDK
major version. Patch releases match across languages where possible.

## Contributing

Each SDK has its own `README.md` with build/test instructions. All four
ship from this monorepo so that adding a new endpoint to the stohr server
prompts a parallel add across all client libraries.
