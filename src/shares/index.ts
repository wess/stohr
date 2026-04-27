import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post, putHeader, stream } from "@atlas/server"
import { requireAuth } from "@atlas/auth"
import { fetchObject } from "../storage/index.ts"
import type { StorageHandle } from "../storage/index.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("")
}

export const shareRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const guard = pipeline(requireAuth({ secret }))
  const authed = pipeline(requireAuth({ secret }), parseJson)

  return [
    get("/shares", guard(async (c) => {
      const userId = authId(c)
      const rows = await db.all(
        from("shares")
          .join("files", raw("files.id = shares.file_id"))
          .where(q => q("shares.user_id").equals(userId))
          .where(q => q("files.deleted_at").isNull())
          .select("shares.id", "shares.token", "shares.expires_at", "shares.created_at", "files.name", "files.size", "files.mime", "shares.file_id")
          .orderBy("shares.created_at", "DESC")
      )
      return json(c, 200, rows)
    })),

    post("/shares", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { file_id?: number; fileId?: number; expires_in?: number; expiresIn?: number }
      const fileId = body.file_id ?? body.fileId
      const expiresIn = body.expires_in ?? body.expiresIn
      if (!fileId) return json(c, 422, { error: "file_id required" })

      const file = await db.one(
        from("files")
          .where(q => q("id").equals(fileId))
          .where(q => q("user_id").equals(userId))
          .where(q => q("deleted_at").isNull())
      )
      if (!file) return json(c, 404, { error: "File not found" })

      const token = randomToken()
      const expiresAt = expiresIn && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null

      const rows = await db.execute(
        from("shares")
          .insert({ file_id: fileId, user_id: userId, token, expires_at: expiresAt })
          .returning("id", "token", "expires_at", "created_at")
      )

      return json(c, 201, rows[0])
    })),

    del("/shares/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("shares").where(q => q("id").equals(id)).where(q => q("user_id").equals(userId))
      )
      if (!row) return json(c, 404, { error: "Share not found" })

      await db.execute(
        from("shares").where(q => q("id").equals(id)).del()
      )
      return json(c, 200, { deleted: id })
    })),

    get("/s/:token", async (c) => {
      const token = c.params.token
      const share = await db.one(
        from("shares").where(q => q("token").equals(token))
      )
      if (!share) return json(c, 404, { error: "Share not found" })

      if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
        return json(c, 410, { error: "Share expired" })
      }

      const file = await db.one(
        from("files")
          .where(q => q("id").equals(share.file_id))
          .where(q => q("deleted_at").isNull())
      )
      if (!file) return json(c, 404, { error: "File missing" })

      const url = new URL(c.request.url)
      if (url.searchParams.get("meta") === "1") {
        return json(c, 200, {
          name: file.name,
          size: file.size,
          mime: file.mime,
          created_at: file.created_at,
        })
      }

      const res = await fetchObject(store, file.storage_key)
      if (!res.body) return json(c, 500, { error: "Storage returned empty body" })

      const inline = url.searchParams.get("inline") === "1"
      const disposition = inline
        ? `inline; filename="${encodeURIComponent(file.name)}"`
        : `attachment; filename="${encodeURIComponent(file.name)}"`

      const withHeaders = putHeader(
        putHeader(
          putHeader(c, "content-type", file.mime),
          "content-disposition",
          disposition,
        ),
        "content-length",
        String(file.size)
      )
      return stream(withHeaders, 200, res.body)
    }),
  ]
}
