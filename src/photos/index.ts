import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { get, json, parseJson, parseMultipart, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { makeKey, put, drop } from "../storage/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { generateImageThumb, isThumbable, THUMB_MAX_BYTES, thumbKeyFor } from "../storage/thumb.ts"
import { checkQuota } from "../usage/index.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

// Cap how many asset IDs the manifest endpoint accepts per request. The
// mobile client should page if it has more than this — keeps the round
// trip bounded.
const MANIFEST_MAX = 1000

// One auto-managed folder per user where mobile-uploaded photos land.
// We don't reuse a "favorites" or "screenshots" subfolder — the protocol
// is intentionally flat so backup history is a single timeline.
const ensurePhotosFolder = async (db: Connection, userId: number): Promise<number> => {
  const existing = await db.one(
    from("folders")
      .where(q => q("user_id").equals(userId))
      .where(q => q("kind").equals("photos"))
      .where(q => q("deleted_at").isNull())
      .where(q => q("parent_id").isNull())
      .select("id"),
  ) as { id: number } | null
  if (existing) return existing.id
  const inserted = await db.execute(
    from("folders").insert({
      user_id: userId,
      parent_id: null,
      name: "Photos",
      kind: "photos",
    }).returning("id"),
  ) as Array<{ id: number }>
  return inserted[0]!.id
}

const parseCapturedAt = (raw: string | undefined): string | null => {
  if (!raw) return null
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return null
  // Clamp absurd values — anything older than 1970 or more than a day in
  // the future is almost certainly a misconfigured device clock.
  const now = Date.now()
  const min = 0
  const max = now + 86400_000
  const t = d.getTime()
  if (t < min || t > max) return null
  return d.toISOString()
}

export const photoRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)
  const upload = pipeline(requireAuth({ secret, db }), parseMultipart)

  return [
    // Step 1: client calls init once at app launch to learn the folder
    // it should upload into and how many photos are already backed up
    // (purely for the UI; backup decisions use /photos/manifest).
    post("/photos/init", guard(async (c) => {
      const userId = authId(c)
      const folderId = await ensurePhotosFolder(db, userId)
      const stats = await db.one({
        text: `
          SELECT COUNT(*)::int AS uploaded,
                 COALESCE(SUM(size), 0)::bigint AS bytes
            FROM files
           WHERE user_id = $1
             AND folder_id = $2
             AND deleted_at IS NULL
             AND photo_asset_id IS NOT NULL
        `,
        values: [userId, folderId],
      }) as { uploaded: number; bytes: string }
      return json(c, 200, {
        folder_id: folderId,
        uploaded: stats.uploaded,
        bytes: Number(stats.bytes),
      })
    })),

    // Step 2: client sends every local asset ID; server returns the
    // subset already on file so the client can skip them. Stateless —
    // the client tracks "I've sync'd" locally and only re-runs the
    // manifest on demand or after long idle.
    post("/photos/manifest", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { asset_ids?: string[]; assetIds?: string[] }
      const ids = body.asset_ids ?? body.assetIds ?? []
      if (!Array.isArray(ids)) return json(c, 422, { error: "asset_ids must be an array of strings" })
      if (ids.length === 0) return json(c, 200, { known: [] })
      if (ids.length > MANIFEST_MAX) {
        return json(c, 422, { error: `asset_ids must contain at most ${MANIFEST_MAX} ids per call` })
      }
      const valid = ids.filter(x => typeof x === "string" && x.length > 0 && x.length < 256)
      if (valid.length === 0) return json(c, 200, { known: [] })

      const rows = await db.execute({
        text: `
          SELECT photo_asset_id
            FROM files
           WHERE user_id = $1
             AND deleted_at IS NULL
             AND photo_asset_id = ANY($2::text[])
        `,
        values: [userId, valid],
      }) as Array<{ photo_asset_id: string }>
      return json(c, 200, { known: rows.map(r => r.photo_asset_id) })
    })),

    // Step 3: idempotent upload. (user, asset_id) is unique, so this
    // is safe to retry as many times as the client wants — duplicate
    // hits return the existing row instead of writing again.
    post("/photos/upload", upload(async (c) => {
      const userId = authId(c)
      const body = c.body as { fields: Record<string, string>; files: Record<string, Blob & { name?: string }> }
      if (!body?.files) return json(c, 422, { error: "No file in upload" })

      const assetId = body.fields?.asset_id ?? body.fields?.assetId
      if (!assetId) return json(c, 422, { error: "asset_id field required" })
      if (assetId.length < 1 || assetId.length > 255) {
        return json(c, 422, { error: "asset_id must be 1-255 chars" })
      }

      // Dedup short-circuit before we materialize the upload to storage.
      const existing = await db.one(
        from("files")
          .where(q => q("user_id").equals(userId))
          .where(q => q("photo_asset_id").equals(assetId))
          .where(q => q("deleted_at").isNull())
          .select("id", "name", "mime", "size", "folder_id", "version", "created_at"),
      ) as { id: number; name: string; mime: string; size: number | string; folder_id: number | null; version: number; created_at: string } | null
      if (existing) {
        return json(c, 200, { ...existing, deduped: true })
      }

      const entries = Object.values(body.files)
      if (entries.length === 0) return json(c, 422, { error: "Expected one file in `file` field" })
      const file = entries[0]!
      const name = (file as any).name ?? `${assetId}.jpg`
      // Prefer the explicit `mime` form field — multipart upload clients
      // tend to send "application/octet-stream" for the part type, which
      // would defeat thumbnail generation.
      const fieldMime = body.fields?.mime
      const mime = (fieldMime && fieldMime.length > 0 ? fieldMime : (file.type || "image/jpeg"))
      const size = file.size
      const capturedAt = parseCapturedAt(body.fields?.captured_at ?? body.fields?.capturedAt)

      // Quota check before write — same pattern as POST /files.
      const owner = await db.one(
        from("users").where(q => q("id").equals(userId)).select("storage_quota_bytes"),
      ) as { storage_quota_bytes: number | string } | null
      const quota = Number(owner?.storage_quota_bytes ?? 0)
      const check = await checkQuota(db, userId, quota, size)
      if (!check.ok) {
        return json(c, 402, {
          error: "Storage quota exceeded",
          quota_bytes: check.quota_bytes,
          used_bytes: check.used_bytes,
          attempted_bytes: check.attempted_bytes,
        })
      }

      const folderId = await ensurePhotosFolder(db, userId)
      const key = makeKey(userId, name)
      await put(store, key, file, mime)

      let thumbKey: string | null = null
      if (isThumbable(mime) && size <= THUMB_MAX_BYTES) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const thumb = await generateImageThumb(bytes, mime)
        if (thumb) {
          thumbKey = thumbKeyFor(key)
          try { await put(store, thumbKey, thumb, "image/webp") } catch { thumbKey = null }
        }
      }

      try {
        const inserted = await db.execute(
          from("files").insert({
            user_id: userId,
            folder_id: folderId,
            name,
            mime,
            size,
            storage_key: key,
            thumb_key: thumbKey,
            version: 1,
            photo_asset_id: assetId,
            captured_at: capturedAt,
          }).returning("id", "name", "mime", "size", "folder_id", "version", "created_at"),
        ) as Array<{ id: number; name: string; mime: string; size: number | string; folder_id: number | null; version: number; created_at: string }>
        return json(c, 201, { ...inserted[0], deduped: false })
      } catch (err) {
        // The (user, asset_id) unique index means a racy double-tap
        // upload by the same client lands here. Surface it as a 200
        // dedup hit so the client treats it the same as the fast path.
        const message = (err as Error).message ?? ""
        if (/files_photo_asset_user_idx|duplicate key value/i.test(message)) {
          await Promise.allSettled([
            drop(store, key),
            ...(thumbKey ? [drop(store, thumbKey)] : []),
          ])
          const dup = await db.one(
            from("files")
              .where(q => q("user_id").equals(userId))
              .where(q => q("photo_asset_id").equals(assetId))
              .where(q => q("deleted_at").isNull())
              .select("id", "name", "mime", "size", "folder_id", "version", "created_at"),
          )
          return json(c, 200, { ...(dup as object), deduped: true })
        }
        // Unknown failure — roll back the blob writes so we don't leak.
        await Promise.allSettled([
          drop(store, key),
          ...(thumbKey ? [drop(store, thumbKey)] : []),
        ])
        throw err
      }
    })),

    // Timeline view — chronological by captured_at (falling back to
    // created_at). Used by the mobile gallery so the user sees their
    // backup as a date-sorted scroll, not a folder.
    get("/photos/timeline", guard(async (c) => {
      const userId = authId(c)
      const url = new URL(c.request.url)
      const limitRaw = Number(url.searchParams.get("limit") ?? "100")
      const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100, 500))
      const before = url.searchParams.get("before")

      const cursor = before ? new Date(before) : null
      const cursorIso = cursor && !Number.isNaN(cursor.getTime()) ? cursor.toISOString() : null

      const rows = await db.execute({
        text: `
          SELECT id, name, mime, size, folder_id, version, photo_asset_id,
                 captured_at, created_at
            FROM files
           WHERE user_id = $1
             AND deleted_at IS NULL
             AND photo_asset_id IS NOT NULL
             ${cursorIso ? "AND COALESCE(captured_at, created_at) < $3" : ""}
           ORDER BY COALESCE(captured_at, created_at) DESC, id DESC
           LIMIT $2
        `,
        values: cursorIso ? [userId, limit, cursorIso] : [userId, limit],
      }) as Array<{ id: number; name: string; mime: string; size: number | string; folder_id: number | null; version: number; photo_asset_id: string; captured_at: string | null; created_at: string }>

      const next = rows.length === limit
        ? (rows[rows.length - 1]!.captured_at ?? rows[rows.length - 1]!.created_at)
        : null
      return json(c, 200, { photos: rows, next })
    })),
  ]
}
