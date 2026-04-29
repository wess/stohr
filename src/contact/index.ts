import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { ownerOnly } from "../security/owner.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import { isEmail } from "../util/username.ts"

type Status = "new" | "read" | "handled" | "spam"

const VALID_STATUSES: ReadonlySet<string> = new Set(["new", "read", "handled", "spam"])
const MAX_NAME = 200
const MAX_SUBJECT = 200
const MAX_MESSAGE = 10_000

const authId = (c: any) => (c.assigns.auth as { id: number }).id

export const contactRoutes = (db: Connection, secret: string) => {
  const open = pipeline(parseJson)
  const ownerCheck = ownerOnly(db)
  const adminGuard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  const adminAuthed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck, parseJson)

  return [
    post("/contact", open(async (c) => {
      const ip = clientIp(c.request)
      const ua = userAgent(c.request)
      const body = c.body as {
        name?: string; email?: string; subject?: string; message?: string
        // Honeypot — real users never see this field. Bots that fill every
        // input get a silent 200 so they don't retry.
        hp?: string
      }

      // Pretend success for honeypot hits.
      const ok = json(c, 200, { ok: true })
      if (body?.hp && body.hp.length > 0) return ok

      const name = (body?.name ?? "").trim()
      const email = (body?.email ?? "").trim().toLowerCase()
      const subject = (body?.subject ?? "").trim()
      const message = (body?.message ?? "").trim()

      if (!name || !email || !subject || !message) {
        return json(c, 422, { error: "All fields are required" })
      }
      if (name.length > MAX_NAME) return json(c, 422, { error: "Name is too long" })
      if (subject.length > MAX_SUBJECT) return json(c, 422, { error: "Subject is too long" })
      if (message.length > MAX_MESSAGE) return json(c, 422, { error: "Message is too long" })
      if (!isEmail(email)) return json(c, 422, { error: "That doesn't look like a valid email" })

      // Two buckets so a single abusive email can't lock everyone out, and
      // a bot rotating fake emails still hits the per-IP cap.
      const ipRate = await checkRate(db, `contact:ip:${ip}`, 5, 3600)
      if (!ipRate.ok) {
        return json(c, 429, { error: "Too many messages from this address. Try again later.", retry_after: ipRate.retryAfterSeconds })
      }
      const emailRate = await checkRate(db, `contact:email:${email}`, 3, 3600)
      if (!emailRate.ok) {
        return json(c, 429, { error: "Too many messages from this email. Try again later.", retry_after: emailRate.retryAfterSeconds })
      }

      await db.execute(
        from("contact_messages").insert({
          name, email, subject, message,
          ip, user_agent: ua,
        }),
      )

      return ok
    })),

    get("/admin/contact", adminGuard(async (c) => {
      const url = new URL(c.request.url)
      const statusParam = url.searchParams.get("status") ?? "all"
      const limitRaw = Number(url.searchParams.get("limit") ?? 100)
      const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 100, 500))
      const offsetRaw = Number(url.searchParams.get("offset") ?? 0)
      const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0)

      let q = from("contact_messages")
        .select("id", "name", "email", "subject", "message", "status", "ip", "user_agent", "handled_by", "handled_at", "created_at")
        .orderBy("created_at", "DESC")
        .limit(limit)
        .offset(offset)
      if (statusParam !== "all" && VALID_STATUSES.has(statusParam)) {
        q = q.where(p => p("status").equals(statusParam))
      }

      const rows = await db.all(q) as Array<{
        id: number
        name: string
        email: string
        subject: string
        message: string
        status: Status
        ip: string | null
        user_agent: string | null
        handled_by: number | null
        handled_at: string | null
        created_at: string
      }>

      // Counts per status — drives the tab badges. Cheap with the partial index.
      const statusCounts = await db.execute({
        text: `SELECT status, COUNT(*)::int AS n FROM contact_messages GROUP BY status`,
        values: [],
      }) as Array<{ status: Status; n: number }>
      const counts: Record<Status, number> = { new: 0, read: 0, handled: 0, spam: 0 }
      for (const row of statusCounts) counts[row.status] = row.n

      const handlerIds = Array.from(new Set(rows.map(r => r.handled_by).filter((x): x is number => x != null)))
      const handlers = handlerIds.length === 0 ? [] : await db.all(
        from("users").where(p => p("id").inList(handlerIds)).select("id", "username", "name"),
      ) as Array<{ id: number; username: string; name: string }>
      const handlerById = new Map(handlers.map(h => [h.id, h]))

      return json(c, 200, {
        items: rows.map(r => ({
          ...r,
          handled_by_user: r.handled_by ? handlerById.get(r.handled_by) ?? null : null,
        })),
        counts,
        limit,
        offset,
      })
    })),

    patch("/admin/contact/:id", adminAuthed(async (c) => {
      const id = Number(c.params.id)
      const body = c.body as { status?: string }
      const status = body?.status
      if (!status || !VALID_STATUSES.has(status)) {
        return json(c, 422, { error: "status must be one of: new, read, handled, spam" })
      }

      const userId = authId(c)
      const settingHandled = status === "handled"
      const patchData: Record<string, unknown> = { status }
      if (settingHandled) {
        patchData.handled_at = raw("NOW()")
        patchData.handled_by = userId
      } else if (status === "new") {
        // Resetting to "new" clears any prior handler so the audit trail
        // doesn't carry stale info.
        patchData.handled_at = null
        patchData.handled_by = null
      }

      const rows = await db.execute(
        from("contact_messages").where(q => q("id").equals(id)).update(patchData).returning("id"),
      ) as Array<{ id: number }>
      if (rows.length === 0) return json(c, 404, { error: "Message not found" })
      return json(c, 200, { id, status })
    })),

    del("/admin/contact/:id", adminGuard(async (c) => {
      const id = Number(c.params.id)
      const rows = await db.execute(
        from("contact_messages").where(q => q("id").equals(id)).del().returning("id"),
      ) as Array<{ id: number }>
      if (rows.length === 0) return json(c, 404, { error: "Message not found" })
      return json(c, 200, { deleted: id })
    })),
  ]
}
