import type { Connection } from "@atlas/db"
import { get, json, pipeline } from "@atlas/server"
import { requireAuth } from "../../auth/guard.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

// Turn a free-text query into a websearch_to_tsquery input. We feed it
// straight through — Postgres's `websearch_to_tsquery` already handles
// quotes, OR, and negation in a search-engine-like syntax, so the caller
// can write `"exact phrase" OR -excluded keyword` and have it Just Work.

export const contentSearchRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))

  return [
    get("/search/content", guard(async (c) => {
      const userId = authId(c)
      const url = new URL(c.request.url)
      const q = (url.searchParams.get("q") ?? "").trim()
      if (!q) return json(c, 200, { files: [], query: q })

      const limitRaw = Number(url.searchParams.get("limit") ?? "20")
      const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20, 50))

      // The visibility rule is "owned by caller OR reachable via a folder
      // collaboration grant that resolves to this folder's ancestry."
      // permissions/index.ts has the same CTE; we inline it here so the
      // search stays a single round-trip rather than fanning out per hit.
      const rows = await db.execute({
        text: `
          WITH q AS (
            SELECT websearch_to_tsquery('english', $1) AS tsq
          ),
          accessible AS (
            SELECT id FROM folders
             WHERE user_id = $2 AND deleted_at IS NULL
            UNION
            SELECT f.id
              FROM folders f
              JOIN (
                WITH RECURSIVE walk AS (
                  SELECT f0.id AS root_id, f0.id AS id
                    FROM folders f0
                    JOIN collaborations c
                      ON c.resource_type = 'folder' AND c.resource_id = f0.id AND c.user_id = $2
                  UNION ALL
                  SELECT w.root_id, fc.id
                    FROM walk w
                    JOIN folders fc ON fc.parent_id = w.id
                )
                SELECT id FROM walk
              ) reach ON reach.id = f.id
          )
          SELECT f.id, f.name, f.mime, f.size, f.folder_id, f.user_id, f.version,
                 f.created_at,
                 ts_rank(f.text_tsv, q.tsq) AS rank,
                 ts_headline('english', coalesce(f.text_content, ''), q.tsq,
                   'MaxWords=20, MinWords=8, ShortWord=2, MaxFragments=1, FragmentDelimiter=" … "'
                 ) AS snippet
            FROM files f, q
           WHERE f.deleted_at IS NULL
             AND f.text_tsv @@ q.tsq
             AND (
               f.user_id = $2
               OR f.folder_id IN (SELECT id FROM accessible)
               OR EXISTS (
                 SELECT 1 FROM collaborations c
                  WHERE c.resource_type = 'file'
                    AND c.resource_id = f.id
                    AND c.user_id = $2
               )
             )
           ORDER BY rank DESC, f.created_at DESC
           LIMIT $3
        `,
        values: [q, userId, limit],
      }) as Array<{
        id: number
        name: string
        mime: string
        size: number | string
        folder_id: number | null
        user_id: number
        version: number
        created_at: string
        rank: number
        snippet: string
      }>

      return json(c, 200, {
        query: q,
        files: rows.map(r => ({
          id: r.id,
          name: r.name,
          mime: r.mime,
          size: r.size,
          folder_id: r.folder_id,
          user_id: r.user_id,
          version: r.version,
          created_at: r.created_at,
          rank: r.rank,
          snippet: r.snippet,
        })),
      })
    })),

    // Owner-only health view: how many files still need indexing, plus
    // last-error stats. Cheap query — the partial index makes this O(N)
    // over pending rows only.
    get("/admin/content-index/status", guard(async (c) => {
      const userId = authId(c)
      const me = await db.one({
        text: `SELECT is_owner FROM users WHERE id = $1`,
        values: [userId],
      }) as { is_owner: boolean } | null
      if (!me?.is_owner) return json(c, 403, { error: "Owner access required" })

      const totals = await db.one({
        text: `
          SELECT
            COUNT(*) FILTER (WHERE deleted_at IS NULL) AS total,
            COUNT(*) FILTER (WHERE deleted_at IS NULL AND text_indexed_at IS NOT NULL AND text_indexed_version >= version) AS indexed,
            COUNT(*) FILTER (WHERE deleted_at IS NULL AND text_extract_error IS NOT NULL) AS errored,
            COUNT(*) FILTER (WHERE deleted_at IS NULL AND (text_indexed_at IS NULL OR text_indexed_version IS NULL OR text_indexed_version < version)) AS pending
          FROM files
        `,
        values: [],
      }) as { total: string; indexed: string; errored: string; pending: string }

      return json(c, 200, {
        total: Number(totals.total),
        indexed: Number(totals.indexed),
        pending: Number(totals.pending),
        errored: Number(totals.errored),
      })
    })),
  ]
}
