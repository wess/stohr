import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, pipeline } from "@atlas/server"
import { requireAuth } from "@atlas/auth"
import { escapeLike, mimePatternsFor, parseQuery } from "./parse.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const clampLimit = (s: string | null, fallback = 20, max = 50): number => {
  if (s === null || s === "") return fallback
  const n = Number(s)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.floor(n), max)
}

export const searchRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret }))

  return [
    get("/search", guard(async (c) => {
      const userId = authId(c)
      const url = new URL(c.request.url)
      const qParam = url.searchParams.get("q") ?? ""
      const limit = clampLimit(url.searchParams.get("limit"))
      const { name, types, exts } = parseQuery(qParam)

      const hasName = name.length > 0
      const hasFilters = types.length > 0 || exts.length > 0

      if (!hasName && !hasFilters) {
        return json(c, 200, { files: [], folders: [] })
      }

      const pattern = `%${escapeLike(name)}%`
      const mimePatterns = types.flatMap(mimePatternsFor)
      const extPatterns = exts.map(e => `%.${escapeLike(e)}`)

      let filesQuery = from("files")
        .where(p => p("user_id").equals(userId))
        .where(p => p("deleted_at").isNull())

      if (hasName) {
        filesQuery = filesQuery.where(p => p("name").ilike(pattern))
      }

      if (mimePatterns.length > 0) {
        filesQuery = filesQuery.where(p =>
          p.or(...mimePatterns.map(m => p("mime").ilike(m))),
        )
      }

      if (extPatterns.length > 0) {
        filesQuery = filesQuery.where(p =>
          p.or(...extPatterns.map(e => p("name").ilike(e))),
        )
      }

      if (hasName) {
        filesQuery = filesQuery.orderBy(raw("similarity(name, $1)", name), "DESC")
      }
      filesQuery = filesQuery
        .orderBy("created_at", "DESC")
        .limit(limit)
        .select("id", "name", "mime", "size", "folder_id", "version", "created_at")

      const files = await db.all(filesQuery)

      const folders = hasName
        ? await db.all(
            from("folders")
              .where(p => p("user_id").equals(userId))
              .where(p => p("deleted_at").isNull())
              .where(p => p("name").ilike(pattern))
              .orderBy(raw("similarity(name, $1)", name), "DESC")
              .orderBy("created_at", "DESC")
              .limit(limit)
              .select("id", "name", "parent_id"),
          )
        : []

      return json(c, 200, { files, folders })
    })),
  ]
}
