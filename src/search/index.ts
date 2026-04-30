import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, pipeline } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { escapeLike, mimePatternsFor, parseQuery } from "./parse.ts"
import { aiStatus, embedText, isAiEnabled } from "../ai/index.ts"
import { semanticSearch } from "../ai/search.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const clampLimit = (s: string | null, fallback = 20, max = 50): number => {
  if (s === null || s === "") return fallback
  const n = Number(s)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.floor(n), max)
}

export const searchRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))

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

    // Semantic search across embedded file contents. 503 when AI is
    // off — clients should fall back to /search. We only return owned
    // files in v1; collaborator visibility comes later.
    get("/search/semantic", guard(async (c) => {
      const userId = authId(c)
      const url = new URL(c.request.url)
      const q = (url.searchParams.get("q") ?? "").trim()
      const limit = clampLimit(url.searchParams.get("limit"), 20, 50)

      if (!isAiEnabled()) {
        return json(c, 503, { error: "Semantic search is disabled on this instance", status: aiStatus() })
      }
      if (!q) return json(c, 422, { error: "q is required" })
      if (q.length > 2000) return json(c, 422, { error: "q exceeds 2000 chars" })

      const vec = embedText(q)
      if (!vec) return json(c, 503, { error: "Embed failed", status: aiStatus() })

      const hits = await semanticSearch(db, userId, vec, limit)
      return json(c, 200, { hits, model: aiStatus().model })
    })),

    get("/search/status", guard(async (c) => json(c, 200, aiStatus()))),
  ]
}
