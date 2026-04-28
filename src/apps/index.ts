import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { randomBytes } from "node:crypto"
import { APP_TOKEN_PREFIX, hashToken, requireAuth } from "../auth/guard.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const generateAppToken = (): string => {
  const raw = randomBytes(32).toString("base64url")
  return `${APP_TOKEN_PREFIX}${raw}`
}

export const appRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/me/apps", guard(async (c) => {
      const userId = authId(c)
      const rows = await db.all(
        from("apps")
          .where(q => q("user_id").equals(userId))
          .select("id", "name", "description", "token_prefix", "last_used_at", "created_at")
          .orderBy("created_at", "DESC"),
      )
      return json(c, 200, rows)
    })),

    post("/me/apps", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { name?: string; description?: string }
      const name = body.name?.trim()
      const description = body.description?.trim() || null
      if (!name) return json(c, 422, { error: "name required" })

      const fullToken = generateAppToken()
      const tokenHash = hashToken(fullToken)
      const tokenPrefix = fullToken.slice(0, APP_TOKEN_PREFIX.length + 6)

      const inserted = await db.execute(
        from("apps")
          .insert({
            user_id: userId,
            name,
            description,
            token_hash: tokenHash,
            token_prefix: tokenPrefix,
          })
          .returning("id", "name", "description", "token_prefix", "created_at"),
      ) as Array<{ id: number; name: string; description: string | null; token_prefix: string; created_at: string }>

      return json(c, 201, {
        ...inserted[0],
        token: fullToken,
        last_used_at: null,
      })
    })),

    del("/me/apps/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("apps")
          .where(q => q("id").equals(id))
          .where(q => q("user_id").equals(userId))
          .select("id"),
      ) as { id: number } | null
      if (!row) return json(c, 404, { error: "App not found" })
      await db.execute(from("apps").where(q => q("id").equals(id)).del())
      return json(c, 200, { revoked: id })
    })),
  ]
}
