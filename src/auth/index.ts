import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, parseJson, pipeline, post } from "@atlas/server"
import { hash, token, verify } from "@atlas/auth"
import { isEmail, isValidUsername, normalizeUsername } from "../util/username.ts"

type UserRow = {
  id: number
  email: string
  username: string
  name: string
  password: string
  is_owner: boolean
}

type AuthUser = { id: number; email: string; username: string; name: string; is_owner: boolean }

const issueToken = (secret: string, user: AuthUser) =>
  token.sign(
    { id: user.id, email: user.email, username: user.username, name: user.name, is_owner: user.is_owner },
    secret,
    { expiresIn: 86400 * 7 },
  )

const userCount = async (db: Connection) => {
  const any = await db.one(from("users").select("id").limit(1))
  return any ? 1 : 0
}

const resolvePendingCollabs = async (db: Connection, userId: number, email: string) => {
  const pending = await db.all(
    from("collaborations")
      .where(q => q("user_id").isNull())
      .where(q => q("email").ilike(email))
      .select("id", "resource_type", "resource_id"),
  ) as Array<{ id: number; resource_type: string; resource_id: number }>

  for (const row of pending) {
    const existing = await db.one(
      from("collaborations")
        .where(q => q("resource_type").equals(row.resource_type))
        .where(q => q("resource_id").equals(row.resource_id))
        .where(q => q("user_id").equals(userId))
        .select("id"),
    ) as { id: number } | null

    if (existing) {
      await db.execute(from("collaborations").where(q => q("id").equals(row.id)).del())
    } else {
      await db.execute(
        from("collaborations").where(q => q("id").equals(row.id)).update({
          user_id: userId,
          email: null,
          accepted_at: raw("NOW()"),
        }),
      )
    }
  }
}

export const authRoutes = (db: Connection, secret: string) => {
  const api = pipeline(parseJson)

  return [
    get("/setup", async (c) => {
      const count = await userCount(db)
      return json(c, 200, { needsSetup: count === 0 })
    }),

    post("/signup", api(async (c) => {
      const body = c.body as {
        name?: string
        email?: string
        username?: string
        password?: string
        invite_token?: string
        inviteToken?: string
      }

      const name = body.name?.trim()
      const email = body.email?.trim().toLowerCase()
      const usernameInput = body.username?.trim()
      const username = usernameInput ? normalizeUsername(usernameInput) : ""
      const password = body.password
      const inviteToken = body.invite_token ?? body.inviteToken

      if (!name || !email || !username || !password) {
        return json(c, 422, { error: "name, email, username, and password are required" })
      }
      if (!isEmail(email)) return json(c, 422, { error: "Invalid email format" })
      if (!isValidUsername(username)) {
        return json(c, 422, { error: "Username must be 3-32 chars, lowercase letters, digits, and underscores" })
      }
      if (password.length < 8) return json(c, 422, { error: "Password must be at least 8 characters" })

      const isFirstUser = (await userCount(db)) === 0

      let invite: { id: number; email: string | null; used_at: string | null } | null = null
      if (!isFirstUser) {
        if (!inviteToken) return json(c, 403, { error: "Invite token required" })
        invite = await db.one(
          from("invites").where(q => q("token").equals(inviteToken)),
        ) as { id: number; email: string | null; used_at: string | null } | null
        if (!invite) return json(c, 403, { error: "Invalid invite token" })
        if (invite.used_at) return json(c, 403, { error: "Invite already used" })
        if (invite.email && invite.email.toLowerCase() !== email) {
          return json(c, 403, { error: "Invite is bound to a different email" })
        }
      }

      const emailTaken = await db.one(
        from("users").where(q => q("email").equals(email)).select("id"),
      )
      if (emailTaken) return json(c, 409, { error: "Email already in use" })

      const usernameTaken = await db.one(
        from("users").where(q => q("username").equals(username)).select("id"),
      )
      if (usernameTaken) return json(c, 409, { error: "Username already in use" })

      const hashed = await hash(password)
      const inserted = await db.execute(
        from("users")
          .insert({ name, email, username, password: hashed, is_owner: isFirstUser })
          .returning("id", "email", "username", "name", "is_owner"),
      ) as Array<AuthUser>
      const user = inserted[0]!

      if (invite) {
        await db.execute(
          from("invites").where(q => q("id").equals(invite!.id)).update({
            used_at: raw("NOW()"),
            used_by: user.id,
          }),
        )
      }

      await resolvePendingCollabs(db, user.id, email)

      return json(c, 201, {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        is_owner: user.is_owner,
        token: await issueToken(secret, user),
      })
    })),

    post("/login", api(async (c) => {
      const body = c.body as {
        identity?: string
        email?: string
        username?: string
        password?: string
      }
      const identity = (body.identity ?? body.email ?? body.username ?? "").trim()
      const password = body.password ?? ""
      if (!identity || !password) return json(c, 422, { error: "identity and password are required" })

      const lookup = identity.includes("@") ? identity.toLowerCase() : normalizeUsername(identity)
      const user = await db.one(
        from("users")
          .where(q => identity.includes("@") ? q("email").equals(lookup) : q("username").equals(lookup))
          .select("id", "email", "username", "name", "password", "is_owner"),
      ) as UserRow | null
      if (!user) return json(c, 401, { error: "Invalid credentials" })

      const ok = await verify(password, user.password)
      if (!ok) return json(c, 401, { error: "Invalid credentials" })

      return json(c, 200, {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        is_owner: user.is_owner,
        token: await issueToken(secret, user),
      })
    })),
  ]
}
