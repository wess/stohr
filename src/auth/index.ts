import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { json, parseJson, pipeline, post } from "@atlas/server"
import { login, signup, token } from "@atlas/auth"

export const authRoutes = (db: Connection, secret: string) => {
  const api = pipeline(parseJson)

  return [
    post("/signup", api(
      signup({
        db,
        table: "users",
        fields: ["email", "name", "password"],
        onSuccess: async (c, user) => {
          const full = await db.one(
            from("users").where(q => q("email").equals(user.email as string)).select("id", "email", "name")
          ) as { id: number; email: string; name: string }
          return json(c, 201, {
            id: full.id,
            email: full.email,
            name: full.name,
            token: await token.sign({ id: full.id, email: full.email, name: full.name }, secret, { expiresIn: 86400 * 7 }),
          })
        },
      })
    )),

    post("/login", api(
      login({
        db,
        table: "users",
        identity: "email",
        password: "password",
        onSuccess: async (c, user) => json(c, 200, {
          id: user.id,
          email: user.email,
          name: user.name,
          token: await token.sign({ id: user.id, email: user.email, name: user.name }, secret, { expiresIn: 86400 * 7 }),
        }),
      })
    )),
  ]
}
