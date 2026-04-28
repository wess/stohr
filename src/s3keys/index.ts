import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { randomBytes } from "node:crypto"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const generateAccessKey = (): string => {
  const buf = randomBytes(15)
  return "AKIA" + buf.toString("base64").replace(/[+/=]/g, "").toUpperCase().slice(0, 16)
}

const generateSecretKey = (): string => {
  return randomBytes(30).toString("base64").replace(/[+/=]/g, "").slice(0, 40)
}

export const s3KeyRoutes = (db: Connection, secret: string) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  return [
    get("/me/s3-keys", guard(async (c) => {
      const userId = authId(c)
      const rows = await db.all(
        from("s3_access_keys")
          .where(q => q("user_id").equals(userId))
          .select("id", "access_key", "name", "last_used_at", "created_at")
          .orderBy("created_at", "DESC"),
      )
      return json(c, 200, rows)
    })),

    post("/me/s3-keys", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as { name?: string }
      const name = body.name?.trim() || null

      const accessKey = generateAccessKey()
      const secretKey = generateSecretKey()

      const inserted = await db.execute(
        from("s3_access_keys")
          .insert({
            user_id: userId,
            access_key: accessKey,
            secret_key: secretKey,
            name,
          })
          .returning("id", "access_key", "name", "created_at"),
      ) as Array<{ id: number; access_key: string; name: string | null; created_at: string }>

      return json(c, 201, {
        ...inserted[0],
        secret_key: secretKey,
        last_used_at: null,
      })
    })),

    del("/me/s3-keys/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const row = await db.one(
        from("s3_access_keys")
          .where(q => q("id").equals(id))
          .where(q => q("user_id").equals(userId))
          .select("id"),
      ) as { id: number } | null
      if (!row) return json(c, 404, { error: "Key not found" })
      await db.execute(from("s3_access_keys").where(q => q("id").equals(id)).del())
      return json(c, 200, { revoked: id })
    })),
  ]
}
