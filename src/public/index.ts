import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { get, json, putHeader, stream } from "@atlas/server"
import { fetchObject } from "../storage/index.ts"
import type { StorageHandle } from "../storage/index.ts"
import { normalizeUsername } from "../util/username.ts"
import { decideInline } from "../security/inline.ts"

type PublicFolder = {
  id: number
  user_id: number
  name: string
  kind: string
  is_public: boolean
}

type PublicFile = {
  id: number
  folder_id: number | null
  name: string
  mime: string
  size: number
  storage_key: string
  thumb_key: string | null
  version: number
  created_at: string
}

const isPublicFolder = async (db: Connection, folderId: number): Promise<PublicFolder | null> => {
  const row = await db.one(
    from("folders")
      .where(q => q("id").equals(folderId))
      .where(q => q("is_public").equals(true))
      .where(q => q("deleted_at").isNull()),
  ) as PublicFolder | null
  return row
}

const fileInPublicFolder = async (db: Connection, fileId: number): Promise<PublicFile | null> => {
  const file = await db.one(
    from("files")
      .where(q => q("id").equals(fileId))
      .where(q => q("deleted_at").isNull()),
  ) as PublicFile | null
  if (!file || file.folder_id == null) return null
  const folder = await isPublicFolder(db, file.folder_id)
  if (!folder) return null
  return file
}

export const publicRoutes = (db: Connection, _secret: string, store: StorageHandle) => [
  get("/p/:username/:folderId", async (c) => {
    const username = normalizeUsername(c.params.username)
    const folderId = Number(c.params.folderId)

    const folder = await isPublicFolder(db, folderId)
    if (!folder) return json(c, 404, { error: "Not found" })

    const owner = await db.one(
      from("users").where(q => q("id").equals(folder.user_id)).select("id", "username", "name"),
    ) as { id: number; username: string; name: string } | null
    if (!owner || owner.username !== username) return json(c, 404, { error: "Not found" })

    // Cap at 500 — large public galleries should paginate; an unbounded list
    // serializes to JSON in API memory and would take down the process if
    // someone made a public folder with a million files.
    const files = await db.all(
      from("files")
        .where(q => q("folder_id").equals(folderId))
        .where(q => q("deleted_at").isNull())
        .select("id", "name", "mime", "size", "version", "created_at")
        .orderBy("created_at", "DESC")
        .limit(500),
    )

    return json(c, 200, {
      folder: {
        id: folder.id,
        name: folder.name,
        kind: folder.kind,
      },
      owner,
      files,
    })
  }),

  get("/p/files/:id", async (c) => {
    const id = Number(c.params.id)
    const file = await fileInPublicFolder(db, id)
    if (!file) return json(c, 404, { error: "Not found" })

    const res = await fetchObject(store, file.storage_key)
    if (!res.body) return json(c, 500, { error: "Storage returned empty body" })

    const wantInline = new URL(c.request.url).searchParams.get("inline") === "1"
    const { contentType, disposition } = decideInline(file.mime, file.name, wantInline)

    const withHeaders = putHeader(
      putHeader(
        putHeader(c, "content-type", contentType),
        "content-disposition",
        disposition,
      ),
      "content-length",
      String(file.size),
    )
    return stream(withHeaders, 200, res.body)
  }),

  get("/p/files/:id/thumb", async (c) => {
    const id = Number(c.params.id)
    const file = await fileInPublicFolder(db, id)
    if (!file || !file.thumb_key) return json(c, 404, { error: "No thumbnail" })

    const res = await fetchObject(store, file.thumb_key)
    if (!res.body) return json(c, 404, { error: "No thumbnail" })

    const withHeaders = putHeader(
      putHeader(c, "content-type", "image/webp"),
      "cache-control",
      "public, max-age=3600",
    )
    return stream(withHeaders, 200, res.body)
  }),
]
