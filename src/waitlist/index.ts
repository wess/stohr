import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { json, parseJson, pipeline, post } from "@atlas/server"
import { isEmail } from "../util/username.ts"
import { checkRate, clientIp } from "../security/ratelimit.ts"

export const waitlistRoutes = (db: Connection) => {
  const open = pipeline(parseJson)

  return [
    post("/invite-requests", open(async (c) => {
      const body = c.body as { email?: string; name?: string; reason?: string }
      const email = (body.email ?? "").trim().toLowerCase()
      const name = body.name?.trim() || null
      const reason = body.reason?.trim() || null

      if (!email) return json(c, 422, { error: "Email is required" })
      if (!isEmail(email)) return json(c, 422, { error: "That doesn't look like a valid email" })
      if (reason && reason.length > 1000) return json(c, 422, { error: "Reason is too long" })

      // Two buckets so a bot rotating emails still hits the per-IP cap, and
      // a single abusive email can't lock everyone else out.
      const ip = clientIp(c.request)
      const ipRate = await checkRate(db, `waitlist:ip:${ip}`, 5, 3600)
      if (!ipRate.ok) {
        return json(c, 429, { error: "Too many requests. Try again later.", retry_after: ipRate.retryAfterSeconds })
      }
      const emailRate = await checkRate(db, `waitlist:email:${email}`, 3, 86400)
      if (!emailRate.ok) {
        return json(c, 429, { error: "Already on the waitlist.", retry_after: emailRate.retryAfterSeconds })
      }

      await db.execute(
        from("invite_requests").insert({ email, name, reason }),
      )
      return json(c, 200, { ok: true })
    })),
  ]
}
