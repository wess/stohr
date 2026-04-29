import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { randomToken, sha256Hex } from "../util/token.ts"
import { isEmail } from "../util/username.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

export const inviteRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/invites", guard(async (c) => {
      const userId = authId(c)
      // The plaintext token is intentionally NOT returned — it only ever
      // exists in the response of POST /invites. The list view shows
      // metadata so the user can revoke or track usage.
      const rows = await db.all(
        from("invites")
          .where(q => q("invited_by").equals(userId))
          .select("id", "email", "used_at", "used_by", "created_at")
          .orderBy("created_at", "DESC"),
      )
      return json(c, 200, rows)
    })),

    post("/invites", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { email?: string }
      const emailRaw = body.email?.trim().toLowerCase()
      if (emailRaw && !isEmail(emailRaw)) return json(c, 422, { error: "Invalid email format" })
      const email = emailRaw || null

      // Generate the plaintext, store only its hash. The plaintext is
      // returned exactly once — same pattern as PATs / app tokens.
      const token = randomToken()
      const rows = await db.execute(
        from("invites")
          .insert({ token_hash: sha256Hex(token), email, invited_by: userId })
          .returning("id", "email", "created_at"),
      ) as Array<{ id: number; email: string | null; created_at: string }>
      return json(c, 201, { ...rows[0], token })
    })),

    del("/invites/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("invites")
          .where(q => q("id").equals(id))
          .where(q => q("invited_by").equals(userId)),
      ) as { id: number; used_at: string | null } | null
      if (!row) return json(c, 404, { error: "Invite not found" })
      if (row.used_at) return json(c, 409, { error: "Cannot revoke a used invite" })

      await db.execute(from("invites").where(q => q("id").equals(id)).del())
      return json(c, 200, { revoked: id })
    })),

    get("/invites/:token/check", async (c) => {
      const token = c.params.token
      const row = await db.one(
        from("invites").where(q => q("token_hash").equals(sha256Hex(token))).select("email", "used_at"),
      ) as { email: string | null; used_at: string | null } | null
      if (!row) return json(c, 404, { valid: false, error: "Invalid invite" })
      if (row.used_at) return json(c, 410, { valid: false, error: "Invite already used" })
      return json(c, 200, { valid: true, email: row.email })
    }),
  ]
}
