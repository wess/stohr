# Mobile photo backup

A small, idempotent protocol for mobile clients to mirror their camera roll to a user's Stohr account.

## The protocol

```
POST /photos/init                      → { folder_id, uploaded, bytes }
POST /photos/manifest { asset_ids[] }  → { known: [...] }       (skip these)
POST /photos/upload                                              (multipart, idempotent)
GET  /photos/timeline?limit=&before=   → { photos[], next }
```

All four require a bearer token (session JWT, PAT, or OAuth access token with read+write scope).

### 1. Init

Call once at app launch. Creates (or finds) the user's `Photos` folder — a regular folder with `kind = 'photos'` rooted at the user's drive. Response includes the folder ID (rarely needed by the client — the upload endpoint figures it out itself) and a summary of how many photos are already backed up, useful for the UI.

### 2. Manifest

Send the client's locally-known asset IDs (up to 1000 per call); the server returns the subset it already has on file. Skip those — they're already up.

An asset ID is whatever the client wants it to be, with two constraints:

- 1–255 chars
- Stable across re-runs of the client on the same device

iOS clients should use `PHAsset.localIdentifier`. Android clients should use the `MediaStore` row ID (or a stable hash thereof if the volume changes). Page through large libraries 1000 IDs at a time.

### 3. Upload

Multipart form. Fields:

| Name | Required | Notes |
|---|---|---|
| `asset_id` | yes | Same value as in the manifest. Server keys dedup off `(user_id, asset_id)`. |
| `mime` | yes | E.g. `image/jpeg`. Don't rely on the multipart Content-Type — many clients send `application/octet-stream`. |
| `captured_at` | no | ISO 8601 — when the photo was taken (EXIF `DateTimeOriginal`, MediaStore `DATE_TAKEN`). Used for timeline ordering. |
| `file` | yes | The photo bytes. |

Response:

```json
{
  "id": 123,
  "name": "IMG_0001.jpg",
  "mime": "image/jpeg",
  "size": 4523123,
  "folder_id": 42,
  "version": 1,
  "created_at": "2026-…",
  "deduped": false
}
```

When `deduped: true`, the server already had this `asset_id` and no bytes were stored. **Retries are safe** — if the network drops mid-upload, just re-upload the same `asset_id` and the server returns the existing row.

Storage quota is enforced (HTTP 402 with `quota_bytes` / `used_bytes` if you'd go over). Thumbnails are generated automatically for image MIME types under 24 MiB.

### 4. Timeline

`/photos/timeline?limit=100&before=2026-05-01T…` returns photos sorted by `COALESCE(captured_at, created_at) DESC`. Use the `next` cursor for pagination — it's the captured_at of the last returned row, suitable for the next `before=`.

## SDK helpers

All four official SDKs expose the same set of methods:

```ts
// TypeScript
client.photos.init()
client.photos.manifest(assetIds)
client.photos.upload({ assetId, file, name, mime, capturedAt })
client.photos.timeline({ limit, before })
```

```dart
// Dart
await api.initPhotoBackup();
final known = await api.photoBackupManifest(localIds);
await api.uploadPhoto(assetId: id, bytes: bytes, name: name, mime: mime, capturedAt: t);
```

```swift
// Swift
let init = try await client.initPhotoBackup()
let known = try await client.photoBackupManifest(assetIds: localIds)
let result = try await client.uploadPhoto(assetId: id, data: bytes, name: name, mime: mime, capturedAt: t)
```

```kotlin
// Kotlin
client.initPhotoBackup()
val known = client.photoBackupManifest(localIds)
client.uploadPhoto(assetId, bytes, name, mime, capturedAtIso = t)
```

## Recommended client loop

```
on app launch:
  initPhotoBackup()
  every N minutes while charging + on Wi-Fi:
    page through camera roll in batches of 1000:
      known = manifest(batch)
      for each id in batch not in known:
        uploadPhoto(id, bytes, name, mime, capturedAt)
    persist a high-water mark so the next pass can skip the whole batch
```

The manifest pass is cheap — it's a single indexed SELECT per 1000 IDs.

## Privacy + storage model

- Photos are first-class files: they show up in `Photos` in My Files and via the regular search/share APIs.
- Storage keys live under the user's per-account prefix (`u<userId>/…`).
- All blob CRUD goes through the API — the photo-backup endpoints never hand out presigned bucket URLs (same contract as every other Stohr upload).
