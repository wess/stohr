import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { get, json, patch, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { issuePasswordReset, passwordResetUrl } from "../auth/password.ts"
import type { Emailer } from "../email/index.ts"
import { passwordResetEmail } from "../email/templates/password.ts"
import { broadcastSystem, sendSystem } from "../messages/system.ts"
import { logEvent } from "../security/audit.ts"
import { ownerOnly } from "../security/owner.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import { revokeAllSessions } from "../security/sessions.ts"
import { unlessLastAdmin } from "../teams/members.ts"
import { teamFor } from "../teams/request.ts"
import { ROOT_TEAM_ID, rootTeam, teamById } from "../teams/resolve.ts"
import type { HostConfig } from "../teams/urls.ts"
import { teamBaseUrl } from "../teams/urls.ts"
import { parseJson } from "../util/json/index.ts"
import { randomToken, sha256Hex } from "../util/token.ts"
import { isEmail, isValidUsername, normalizeUsername } from "../util/username.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

type UserDetail = {
  id: number
  username: string
  email: string
  name: string
  is_owner: boolean
  team_id: number
  team_admin: boolean
  storage_quota_bytes: number | string
  totp_enabled: boolean
  suspended_at: string | null
  suspended_reason: string | null
  suspended_by: number | null
  deleted_at: string | null
  created_at: string
}

// The same handlers serve the owner at /admin/users (any team) and team
// admins at /team/users (the host's team only). The scope decides which
// rows exist for the caller and what they may do to them: a team admin
// never sees another team, never touches an owner, and cannot leave their
// team without an active admin.
export type UserAdminScope = {
  actor: "owner" | "team_admin"
  teamId: (c: Conn) => number | null
}

export const OWNER_SCOPE: UserAdminScope = { actor: "owner", teamId: () => null }
export const TEAM_SCOPE: UserAdminScope = { actor: "team_admin", teamId: c => teamFor(c.request).team.id }

type TargetRow = Pick<UserDetail, "id" | "is_owner" | "team_id" | "team_admin" | "suspended_at" | "deleted_at">

// Emails and usernames are unique across the instance, so a 409 from an
// admin's edit or create tells a team admin whether an address exists on
// some other team. Attempts that carry one are bounded per actor and every
// conflict is logged, so probing is slow and leaves a trail.
export const identityRate = (db: Connection, actorId: number) =>
  checkRate(db, `admin:identity:user:${actorId}`, 30, 900)

export const identityConflict = (
  db: Connection,
  c: Conn,
  teamId: number,
  field: "email" | "username",
  target: number | null,
  actor: UserAdminScope["actor"],
): void =>
  logEvent(db, {
    userId: authId(c),
    teamId,
    event: "admin.identity_conflict",
    metadata: { field, target, actor },
    ip: clientIp(c.request),
    userAgent: userAgent(c.request),
  })

export const userAdminHandlers = (db: Connection, emailer: Emailer, hosts: HostConfig, scope: UserAdminScope) => {
  const target = async (c: Conn, id: number): Promise<TargetRow | null> => {
    if (!Number.isInteger(id)) return null
    const teamId = scope.teamId(c)
    let q = from("users")
      .where(p => p("id").equals(id))
      .select("id", "is_owner", "team_id", "team_admin", "suspended_at", "deleted_at")
    if (teamId !== null) q = q.where(p => p("team_id").equals(teamId))
    return (await db.one(q)) as TargetRow | null
  }

  // a team admin may not act on an owner; the owner may act on anyone
  const outranks = (row: TargetRow): boolean => scope.actor === "owner" || !row.is_owner

  const detail = async (c: Conn) => {
    const id = Number(c.params.id)
    const found = await target(c, id)
    if (!found) return json(c, 404, { error: "User not found" })
    const user = (await db.one(
      from("users")
        .where(q => q("id").equals(id))
        .select(
          "id",
          "username",
          "email",
          "name",
          "is_owner",
          "team_id",
          "team_admin",
          "storage_quota_bytes",
          "totp_enabled",
          "suspended_at",
          "suspended_reason",
          "suspended_by",
          "deleted_at",
          "created_at",
        ),
    )) as UserDetail | null
    if (!user) return json(c, 404, { error: "User not found" })

    const usage = (await db.one({
      text: `
          SELECT
            COALESCE(SUM(size), 0)::bigint AS bytes,
            COUNT(*)::int AS files
          FROM files
          WHERE user_id = $1 AND deleted_at IS NULL
        `,
      values: [id],
    })) as { bytes: string; files: number }

    const sessionCount = (await db.one({
      text: `SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      values: [id],
    })) as { n: number }

    return json(c, 200, {
      ...user,
      storage_quota_bytes: Number(user.storage_quota_bytes),
      storage_bytes: Number(usage.bytes),
      file_count: usage.files,
      active_sessions: sessionCount.n,
    })
  }

  const edit = async (c: Conn) => {
    const userId = authId(c)
    const id = Number(c.params.id)
    const body = c.body as {
      name?: string
      email?: string
      username?: string
      team_admin?: boolean
      teamAdmin?: boolean
    }
    const update: Record<string, unknown> = {}

    const found = await target(c, id)
    if (!found) return json(c, 404, { error: "User not found" })
    if (!outranks(found)) return json(c, 403, { error: "Cannot edit an owner" })

    if (body.name !== undefined) {
      const name = body.name.trim()
      if (!name) return json(c, 422, { error: "name must not be empty" })
      update.name = name
    }
    if (body.email !== undefined || body.username !== undefined) {
      const rate = await identityRate(db, userId)
      if (!rate.ok) {
        return json(c, 429, { error: "Too many attempts. Try again later.", retry_after: rate.retryAfterSeconds })
      }
    }
    if (body.email !== undefined) {
      const email = body.email.trim().toLowerCase()
      if (!isEmail(email)) return json(c, 422, { error: "Invalid email format" })
      const taken = await db.one(
        from("users")
          .where(q => q("email").equals(email))
          .where(q => q("id").notEquals(id))
          .select("id"),
      )
      if (taken) {
        identityConflict(db, c, Number(found.team_id), "email", id, scope.actor)
        return json(c, 409, { error: "Email already in use" })
      }
      update.email = email
    }
    if (body.username !== undefined) {
      const username = normalizeUsername(body.username)
      if (!isValidUsername(username))
        return json(c, 422, { error: "Username must be 3-32 chars, lowercase letters, digits, and underscores" })
      const taken = await db.one(
        from("users")
          .where(q => q("username").equals(username))
          .where(q => q("id").notEquals(id))
          .select("id"),
      )
      if (taken) {
        identityConflict(db, c, Number(found.team_id), "username", id, scope.actor)
        return json(c, 409, { error: "Username already in use" })
      }
      update.username = username
    }
    // team_admin is the only role either caller may change here; is_owner
    // has its own owner-only route and is never reachable from /team
    const teamAdmin = body.team_admin ?? body.teamAdmin
    if (teamAdmin !== undefined) {
      if (typeof teamAdmin !== "boolean") return json(c, 422, { error: "team_admin must be a boolean" })
      if (teamAdmin !== found.team_admin) update.team_admin = teamAdmin
    }
    if (Object.keys(update).length === 0) return json(c, 422, { error: "Nothing to update" })

    const write = (conn: Connection) =>
      conn.execute(
        from("users")
          .where(q => q("id").equals(id))
          .update(update),
      )
    // a demotion is checked and written in one step so two admins cannot
    // demote each other past the last one
    if (update.team_admin === false && !found.suspended_at && !found.deleted_at) {
      const ok = await unlessLastAdmin(db, Number(found.team_id), id, write)
      if (!ok) return json(c, 422, { error: "Cannot demote the last active admin of a team" })
    } else {
      await write(db)
    }
    logEvent(db, {
      userId,
      teamId: Number(found.team_id),
      event: "admin.user_edited",
      metadata: { target: id, fields: Object.keys(update), actor: scope.actor },
    })
    return json(c, 200, { id, updated: Object.keys(update) })
  }

  const suspend = async (c: Conn) => {
    const userId = authId(c)
    const id = Number(c.params.id)
    const body = c.body as { reason?: string }
    if (id === userId) return json(c, 422, { error: "Cannot suspend yourself" })
    const found = await target(c, id)
    if (!found) return json(c, 404, { error: "User not found" })
    if (found.is_owner) return json(c, 422, { error: "Cannot suspend an owner" })
    if (found.suspended_at) return json(c, 409, { error: "User is already suspended" })

    const write = (conn: Connection) =>
      conn.execute(
        from("users")
          .where(q => q("id").equals(id))
          .update({
            suspended_at: raw("NOW()"),
            suspended_reason: body.reason?.trim() ?? null,
            suspended_by: userId,
          }),
      )
    if (found.team_admin && !found.deleted_at) {
      const ok = await unlessLastAdmin(db, Number(found.team_id), id, write)
      if (!ok) return json(c, 422, { error: "Cannot suspend the last active admin of a team" })
    } else {
      await write(db)
    }
    await revokeAllSessions(db, id)

    const by = scope.actor === "owner" ? "An owner of this Stohr instance" : "An admin of your team"
    void sendSystem(
      db,
      id,
      "Your account has been suspended",
      body.reason
        ? `${by} has suspended your account.\n\nReason given:\n${body.reason}\n\nContact them to restore access.`
        : `${by} has suspended your account. Contact them to restore access.`,
    )

    logEvent(db, {
      userId,
      teamId: Number(found.team_id),
      event: "admin.user_suspended",
      metadata: { target: id, reason: body.reason ?? null, actor: scope.actor },
    })
    return json(c, 200, { id, suspended: true })
  }

  const unsuspend = async (c: Conn) => {
    const userId = authId(c)
    const id = Number(c.params.id)
    const found = await target(c, id)
    if (!found) return json(c, 404, { error: "User not found" })
    if (!found.suspended_at) return json(c, 409, { error: "User is not suspended" })

    await db.execute(
      from("users")
        .where(q => q("id").equals(id))
        .update({
          suspended_at: null,
          suspended_reason: null,
          suspended_by: null,
        }),
    )
    void sendSystem(
      db,
      id,
      "Your account has been restored",
      "Your account is active again. You can sign in normally now.",
    )
    logEvent(db, {
      userId,
      teamId: Number(found.team_id),
      event: "admin.user_unsuspended",
      metadata: { target: id, actor: scope.actor },
    })
    return json(c, 200, { id, suspended: false })
  }

  // Mint a password-reset token and email it to the user. If email is
  // disabled (no RESEND_API_KEY), the admin gets the URL back in the
  // response so they can hand it over out-of-band. The link lands on the
  // target's own team host — the owner may be resetting a tenant user.
  const resetPassword = async (c: Conn) => {
    const userId = authId(c)
    const id = Number(c.params.id)
    const found = await target(c, id)
    if (!found || found.deleted_at) return json(c, 404, { error: "User not found" })
    if (!outranks(found)) return json(c, 403, { error: "Cannot reset an owner's password" })
    const user = (await db.one(
      from("users")
        .where(q => q("id").equals(id))
        .select("id", "name", "email"),
    )) as { id: number; name: string; email: string } | null
    if (!user) return json(c, 404, { error: "User not found" })

    const { token } = await issuePasswordReset(db, user.id, null)
    const team = (await teamById(db, Number(found.team_id))) ?? (await rootTeam(db))
    const resetUrl = passwordResetUrl(teamBaseUrl(team, hosts), token)
    const tpl = passwordResetEmail({ name: user.name, resetUrl })
    const sent = await emailer.send({
      to: user.email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    })

    // `sent` is always an object, so it has to be read, not truth-tested:
    // a failed send is { ok: false }, and with email off the message is
    // only logged ({ ok: true, logged: true }). Neither reached the user.
    const delivered = sent.ok && !sent.logged
    logEvent(db, {
      userId,
      teamId: Number(found.team_id),
      event: "admin.password_reset_issued",
      metadata: { target: id, emailed: delivered, error: sent.ok ? null : sent.error, actor: scope.actor },
    })

    return json(c, 200, {
      id,
      emailed: delivered,
      // The admin sees the URL only when delivery wasn't possible —
      // this avoids handing the token to a different admin tab unless
      // it's actually needed.
      reset_url: delivered ? null : resetUrl,
    })
  }

  const message = async (c: Conn) => {
    const userId = authId(c)
    const id = Number(c.params.id)
    const body = c.body as { subject?: string; body?: string }
    const subject = body.subject?.trim()
    const messageBody = body.body?.trim()
    if (!subject || !messageBody) return json(c, 422, { error: "subject and body are required" })
    const found = await target(c, id)
    if (!found || found.deleted_at) return json(c, 404, { error: "User not found" })
    const messageId = await sendSystem(db, id, subject, messageBody)
    logEvent(db, {
      userId,
      teamId: Number(found.team_id),
      event: "admin.message_sent",
      metadata: { target: id, message_id: messageId, actor: scope.actor },
    })
    return json(c, 201, { id: messageId })
  }

  return { target, detail, edit, suspend, unsuspend, resetPassword, message }
}

export const adminUserRoutes = (db: Connection, secret: string, emailer: Emailer, hosts: HostConfig) => {
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck, parseJson)
  const h = userAdminHandlers(db, emailer, hosts, OWNER_SCOPE)

  return [
    get("/admin/users/:id", guard(h.detail)),
    patch("/admin/users/:id", authed(h.edit)),
    post("/admin/users/:id/suspend", authed(h.suspend)),
    post("/admin/users/:id/unsuspend", authed(h.unsuspend)),
    post("/admin/users/:id/reset-password", authed(h.resetPassword)),
    post("/admin/users/:id/message", authed(h.message)),

    // An announcement goes to one team: the owner's own (root) unless a
    // team_id names another. Never to the whole instance at once.
    post(
      "/admin/broadcast",
      authed(async c => {
        const userId = authId(c)
        const body = c.body as { subject?: string; body?: string; team_id?: number; teamId?: number }
        const subject = body.subject?.trim()
        const messageBody = body.body?.trim()
        if (!subject || !messageBody) return json(c, 422, { error: "subject and body are required" })
        const requested = body.team_id ?? body.teamId
        let teamId = ROOT_TEAM_ID
        if (requested !== undefined) {
          if (typeof requested !== "number" || !Number.isInteger(requested)) {
            return json(c, 422, { error: "team_id must be an integer" })
          }
          const team = await teamById(db, requested)
          if (!team || team.deleted_at) return json(c, 404, { error: "Team not found" })
          teamId = team.id
        }
        const delivered = await broadcastSystem(db, teamId, subject, messageBody)
        logEvent(db, { userId, teamId, event: "admin.broadcast", metadata: { delivered, team_id: teamId } })
        return json(c, 201, { delivered, team_id: teamId })
      }),
    ),

    // Create a targeted invite (with optional email binding) from the
    // admin UI. The /invites endpoint covers per-user invites; this one
    // is for the owner managing access centrally — for the root team.
    post(
      "/admin/invites",
      authed(async c => {
        const userId = authId(c)
        const body = c.body as { email?: string }
        const emailRaw = body.email?.trim().toLowerCase()
        if (emailRaw && !isEmail(emailRaw)) return json(c, 422, { error: "Invalid email format" })
        const email = emailRaw || null
        const token = randomToken()
        const rows = (await db.execute(
          from("invites")
            .insert({ token_hash: sha256Hex(token), email, invited_by: userId, team_id: ROOT_TEAM_ID })
            .returning("id", "email", "created_at"),
        )) as Array<{ id: number; email: string | null; created_at: string }>
        return json(c, 201, { ...rows[0], token })
      }),
    ),
  ]
}
