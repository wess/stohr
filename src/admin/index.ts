import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { randomToken, sha256Hex } from "../util/token.ts"
import type { Emailer } from "../email/index.ts"
import { inviteEmail } from "../email/templates/invite.ts"
import { ownerOnly } from "../security/owner.ts"
import { aiModelId, aiStatus, isAiEnabled } from "../ai/index.ts"
import { isEmbeddableMime } from "../ai/extract.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

type InviteRequest = {
  id: number
  email: string
  name: string | null
  reason: string | null
  status: string
  processed_at: string | null
  processed_by: number | null
  created_at: string
}

export const adminRoutes = (db: Connection, secret: string, emailer: Emailer, appUrl: string) => {
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck, parseJson)

  return [
    get("/admin/invite-requests", guard(async (c) => {
      const url = new URL(c.request.url)
      const status = url.searchParams.get("status") ?? "pending"
      const rows = await db.all(
        from("invite_requests")
          .where(q => status === "all" ? q("id").isNotNull() : q("status").equals(status))
          .orderBy("created_at", "DESC")
          .limit(200),
      )
      return json(c, 200, rows)
    })),

    post("/admin/invite-requests/:id/invite", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("invite_requests").where(q => q("id").equals(id)),
      ) as InviteRequest | null
      if (!row) return json(c, 404, { error: "Request not found" })
      if (row.status !== "pending") return json(c, 409, { error: `Already ${row.status}` })

      // Always issue a fresh invite token here. We can no longer reuse a
      // pre-existing unused invite for the same email because the plaintext
      // is not stored — only its hash. Issuing a new one supersedes the old
      // (older invites for the same email remain valid until used or revoked,
      // but the user is emailed only the fresh one).
      const inviteToken = randomToken()
      await db.execute(
        from("invites").insert({
          token_hash: sha256Hex(inviteToken),
          email: row.email,
          invited_by: userId,
        }),
      )

      await db.execute(
        from("invite_requests").where(q => q("id").equals(id)).update({
          status: "invited",
          processed_at: raw("NOW()"),
          processed_by: userId,
        }),
      )

      const inviter = await db.one(
        from("users").where(q => q("id").equals(userId)).select("name", "username"),
      ) as { name: string; username: string } | null
      const signupUrl = `${appUrl.replace(/\/$/, "")}/signup?invite=${encodeURIComponent(inviteToken)}`
      const tpl = inviteEmail({
        inviterName: inviter?.name ?? inviter?.username ?? null,
        email: row.email,
        signupUrl,
        note: row.reason,
      })
      const sendRes = await emailer.send({
        to: row.email,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      })

      return json(c, 200, {
        id,
        invite_token: inviteToken,
        email: row.email,
        email_sent: sendRes.ok,
        email_error: sendRes.ok ? undefined : sendRes.error,
      })
    })),

    post("/admin/invite-requests/:id/dismiss", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("invite_requests").where(q => q("id").equals(id)),
      ) as InviteRequest | null
      if (!row) return json(c, 404, { error: "Request not found" })
      if (row.status !== "pending") return json(c, 409, { error: `Already ${row.status}` })

      await db.execute(
        from("invite_requests").where(q => q("id").equals(id)).update({
          status: "dismissed",
          processed_at: raw("NOW()"),
          processed_by: userId,
        }),
      )
      return json(c, 200, { dismissed: id })
    })),

    del("/admin/invite-requests/:id", guard(async (c) => {
      const id = Number(c.params.id)
      await db.execute(from("invite_requests").where(q => q("id").equals(id)).del())
      return json(c, 200, { deleted: id })
    })),

    get("/admin/users", guard(async (c) => {
      const users = await db.all(
        from("users")
          .select("id", "username", "email", "name", "is_owner", "created_at")
          .orderBy("created_at", "DESC"),
      ) as Array<{ id: number; username: string; email: string; name: string; is_owner: boolean; created_at: string }>

      const files = await db.all(
        from("files")
          .where(q => q("deleted_at").isNull())
          .select("user_id", "size"),
      ) as Array<{ user_id: number; size: number | string }>

      const usage = new Map<number, { bytes: number; files: number }>()
      for (const f of files) {
        const cur = usage.get(f.user_id) ?? { bytes: 0, files: 0 }
        usage.set(f.user_id, { bytes: cur.bytes + Number(f.size), files: cur.files + 1 })
      }

      return json(c, 200, users.map(u => ({
        ...u,
        storage_bytes: usage.get(u.id)?.bytes ?? 0,
        file_count: usage.get(u.id)?.files ?? 0,
      })))
    })),

    post("/admin/users/:id/owner", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const body = c.body as { is_owner?: boolean }
      if (typeof body.is_owner !== "boolean") return json(c, 422, { error: "is_owner boolean required" })
      if (id === userId && body.is_owner === false) return json(c, 422, { error: "Cannot remove owner from yourself" })

      await db.execute(
        from("users").where(q => q("id").equals(id)).update({ is_owner: body.is_owner }),
      )
      return json(c, 200, { id, is_owner: body.is_owner })
    })),

    del("/admin/users/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      if (id === userId) return json(c, 422, { error: "Cannot delete yourself from admin — use Settings" })
      await db.execute(from("users").where(q => q("id").equals(id)).del())
      return json(c, 200, { deleted: id })
    })),

    get("/admin/invites", guard(async (c) => {
      const url = new URL(c.request.url)
      const filter = url.searchParams.get("filter") ?? "all"
      // Plaintext token is never returned on read paths — only at create time.
      let q = from("invites").select("id", "email", "invited_by", "used_at", "used_by", "created_at")
      if (filter === "unused") q = q.where(p => p("used_at").isNull())
      if (filter === "used") q = q.where(p => p("used_at").isNotNull())

      const rows = await db.all(q.orderBy("created_at", "DESC").limit(500)) as Array<{
        id: number
        email: string | null
        invited_by: number | null
        used_at: string | null
        used_by: number | null
        created_at: string
      }>

      const userIds = Array.from(new Set([
        ...rows.map(r => r.invited_by).filter((x): x is number => x != null),
        ...rows.map(r => r.used_by).filter((x): x is number => x != null),
      ]))
      const users = userIds.length === 0 ? [] : await db.all(
        from("users").where(p => p("id").inList(userIds)).select("id", "username"),
      ) as Array<{ id: number; username: string }>
      const byId = new Map(users.map(u => [u.id, u.username]))

      return json(c, 200, rows.map(r => ({
        ...r,
        invited_by_username: r.invited_by ? byId.get(r.invited_by) ?? null : null,
        used_by_username: r.used_by ? byId.get(r.used_by) ?? null : null,
      })))
    })),

    del("/admin/invites/:id", guard(async (c) => {
      const id = Number(c.params.id)
      const row = await db.one(
        from("invites").where(q => q("id").equals(id)).select("id", "used_at"),
      ) as { id: number; used_at: string | null } | null
      if (!row) return json(c, 404, { error: "Invite not found" })
      if (row.used_at) return json(c, 409, { error: "Cannot delete a used invite" })
      await db.execute(from("invites").where(q => q("id").equals(id)).del())
      return json(c, 200, { deleted: id })
    })),

    get("/admin/stats", guard(async (c) => {
      const users = await db.all(from("users").select("id")) as Array<{ id: number }>
      const folders = await db.all(from("folders").where(q => q("deleted_at").isNull()).select("id")) as Array<{ id: number }>
      const files = await db.all(from("files").where(q => q("deleted_at").isNull()).select("size")) as Array<{ size: number | string }>
      const invitesAll = await db.all(from("invites").select("id", "used_at")) as Array<{ id: number; used_at: string | null }>
      const requestsPending = await db.all(
        from("invite_requests").where(q => q("status").equals("pending")).select("id"),
      ) as Array<{ id: number }>

      const totalBytes = files.reduce((acc, f) => acc + Number(f.size), 0)
      const invitesUsed = invitesAll.filter(i => i.used_at).length

      return json(c, 200, {
        users: users.length,
        folders: folders.length,
        files: files.length,
        total_storage_bytes: totalBytes,
        invites_total: invitesAll.length,
        invites_used: invitesUsed,
        invites_unused: invitesAll.length - invitesUsed,
        requests_pending: requestsPending.length,
      })
    })),

    get("/admin/ai", guard(async (c) => {
      // Coverage stats so the operator can see what's embedded vs. what's
      // pending. Cheap query — counts only.
      const status = aiStatus()
      const totalRow = await db.one({
        text: "SELECT COUNT(*)::int AS n FROM files WHERE deleted_at IS NULL",
        values: [],
      }) as { n: number } | null
      const embeddedRow = await db.one({
        text: status.model
          ? "SELECT COUNT(*)::int AS n FROM file_embeddings WHERE model = $1"
          : "SELECT COUNT(*)::int AS n FROM file_embeddings",
        values: status.model ? [status.model] : [],
      }) as { n: number } | null
      const pendingRow = await db.one({
        text: `SELECT COUNT(*)::int AS n FROM jobs
               WHERE type = 'embeddings.generate' AND status IN ('pending', 'running')`,
        values: [],
      }) as { n: number } | null
      const deadRow = await db.one({
        text: `SELECT COUNT(*)::int AS n FROM jobs
               WHERE type = 'embeddings.generate' AND status = 'dead'`,
        values: [],
      }) as { n: number } | null
      return json(c, 200, {
        ...status,
        files_total: totalRow?.n ?? 0,
        files_embedded: embeddedRow?.n ?? 0,
        jobs_pending: pendingRow?.n ?? 0,
        jobs_dead: deadRow?.n ?? 0,
      })
    })),

    post("/admin/ai/backfill", authed(async (c) => {
      // Enqueues embeddings.generate jobs for every non-deleted file that
      // is missing a current-model embedding. Idempotent: re-running while
      // a previous backfill is still draining is safe (the dispatcher
      // dedupes nothing, but the handler will skip files whose embedding
      // is already current via the content-hash + model check).
      if (!isAiEnabled()) {
        return json(c, 503, { error: "AI is disabled on this instance", status: aiStatus() })
      }
      const model = aiModelId()
      if (!model) {
        return json(c, 503, { error: "No active embedding model" })
      }

      const body = (c.body ?? {}) as { force?: boolean; limit?: number }
      const force = !!body.force
      const limit = (() => {
        const n = Number(body.limit)
        if (!Number.isFinite(n) || n <= 0) return 5000
        return Math.min(50_000, Math.floor(n))
      })()

      // Pull candidate files. The handler will further filter by mime,
      // but pre-filtering at SQL keeps the candidate set sane on
      // instances with millions of binary files.
      const rows = await db.execute({
        text: force
          ? `SELECT id, mime FROM files
             WHERE deleted_at IS NULL
             ORDER BY created_at DESC
             LIMIT $1`
          : `SELECT f.id, f.mime FROM files f
             LEFT JOIN file_embeddings e ON e.file_id = f.id AND e.model = $1
             WHERE f.deleted_at IS NULL AND e.file_id IS NULL
             ORDER BY f.created_at DESC
             LIMIT $2`,
        values: force ? [limit] : [model, limit],
      }) as Array<{ id: number | string; mime: string }>

      const candidates = rows.filter(r => isEmbeddableMime(r.mime))
      if (candidates.length === 0) return json(c, 200, { enqueued: 0, scanned: rows.length })

      // Single batch insert. Postgres is happy with thousands of
      // VALUES rows — well under the 65k parameter limit at 4 params/row.
      const values: unknown[] = []
      const placeholders: string[] = []
      candidates.forEach((r, i) => {
        const base = i * 4
        placeholders.push(`($${base + 1}, $${base + 2}::jsonb, NOW(), $${base + 3}::int)`)
        values.push("embeddings.generate", JSON.stringify({ file_id: Number(r.id) }), 3)
      })
      // Above pushed only 3 values per row but used 4 placeholders — fix:
      values.length = 0
      placeholders.length = 0
      candidates.forEach((r, i) => {
        const base = i * 3
        placeholders.push(`($${base + 1}, $${base + 2}::jsonb, $${base + 3}::int)`)
        values.push("embeddings.generate", JSON.stringify({ file_id: Number(r.id) }), 3)
      })
      const sql = `INSERT INTO jobs (type, payload, max_attempts) VALUES ${placeholders.join(", ")}`
      await db.execute({ text: sql, values })

      return json(c, 200, { enqueued: candidates.length, scanned: rows.length, model, limit, force })
    })),

    get("/admin/audit", guard(async (c) => {
      const url = new URL(c.request.url)
      const event = url.searchParams.get("event")
      const userIdParam = url.searchParams.get("user_id")
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100)))

      let q = from("audit_events")
        .leftJoin("users", raw("users.id = audit_events.user_id"))
        .select(
          "audit_events.id",
          "audit_events.user_id",
          "audit_events.event",
          "audit_events.metadata",
          "audit_events.ip",
          "audit_events.user_agent",
          "audit_events.created_at",
          raw("users.username AS username"),
          raw("users.email AS user_email"),
        )
        .orderBy("audit_events.created_at", "DESC")
        .limit(limit)

      if (event) q = q.where(qb => qb("audit_events.event").equals(event))
      if (userIdParam) {
        const uid = Number(userIdParam)
        if (!Number.isNaN(uid)) q = q.where(qb => qb("audit_events.user_id").equals(uid))
      }

      const rows = await db.all(q)
      return json(c, 200, rows)
    })),
  ]
}
