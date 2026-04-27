import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { json, parseJson, pipeline, post } from "@atlas/server"
import { isEmail } from "../util/username.ts"

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

      await db.execute(
        from("invite_requests").insert({ email, name, reason }),
      )
      return json(c, 200, { ok: true })
    })),
  ]
}
