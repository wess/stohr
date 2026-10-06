// Team-admin surface, scoped to the host's team: the owner-only /admin
// equivalents with the team pinned by the request host rather than chosen
// by the caller.

import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { del, get, json, patch, pipeline, post } from "@atlas/server"
import { identityConflict, identityRate, TEAM_SCOPE, userAdminHandlers } from "../admin/users.ts"
import { purgeUser } from "../auth/deletion.ts"
import { requireAuth } from "../auth/guard.ts"
import type { Emailer } from "../email/index.ts"
import { logEvent } from "../security/audit.ts"
import type { StorageHandle } from "../storage/index.ts"
import { parseJson } from "../util/json/index.ts"
import { randomToken, sha256Hex } from "../util/token.ts"
import { isEmail } from "../util/username.ts"
import type { TxtLookup } from "./domains.ts"
import { domainRoutes } from "./domains.ts"
import { teamAdminOnly } from "./guards.ts"
import { computeTeamUsage, countTeamUsers, unlessLastAdmin } from "./members.ts"
import { teamFor } from "./request.ts"
import type { HostConfig } from "./urls.ts"
import { createTeamUser, issueSetPasswordLink } from "./users.ts"

const authId = (c: Conn) => (c.assigns.auth as { id: number }).id

export const teamRoutes = (
  db: Connection,
  secret: string,
  emailer: Emailer,
  store: StorageHandle,
  hosts: HostConfig,
  txt?: TxtLookup,
) => {
  const adminCheck = teamAdminOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), adminCheck)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), adminCheck, parseJson)
  const h = userAdminHandlers(db, emailer, hosts, TEAM_SCOPE)

  return [
    ...domainRoutes(db, secret, hosts, txt),
    // own team: identity, quota and how much of it is used
    get(
      "/team",
      guard(async c => {
        const { team, baseUrl } = teamFor(c.request)
        return json(c, 200, {
          id: team.id,
          slug: team.slug,
          name: team.name,
          quota_bytes: team.quota_bytes,
          suspended_at: team.suspended_at,
          created_at: team.created_at,
          base_url: baseUrl,
          user_count: await countTeamUsers(db, team.id),
          usage: await computeTeamUsage(db, team.id),
        })
      }),
    ),

    get(
      "/team/users",
      guard(async c => {
        const teamId = teamFor(c.request).team.id
        const users = (await db.all(
          from("users")
            .where(q => q("team_id").equals(teamId))
            .select(
              "id",
              "username",
              "email",
              "name",
              "is_owner",
              "team_admin",
              "storage_quota_bytes",
              "suspended_at",
              "deleted_at",
              "created_at",
            )
            .orderBy("created_at", "DESC")
            .orderBy("id", "DESC"),
        )) as Array<Record<string, unknown> & { id: number; storage_quota_bytes: number | string }>

        const files = (await db.all({
          text: `SELECT user_id, COALESCE(SUM(size), 0)::bigint AS bytes, COUNT(*)::int AS files
                   FROM files
                  WHERE deleted_at IS NULL AND user_id IN (SELECT id FROM users WHERE team_id = $1)
                  GROUP BY user_id`,
          values: [teamId],
        })) as Array<{ user_id: number; bytes: string; files: number }>
        const usage = new Map(files.map(f => [f.user_id, f]))

        return json(
          c,
          200,
          users.map(u => ({
            ...u,
            storage_quota_bytes: Number(u.storage_quota_bytes),
            storage_bytes: Number(usage.get(u.id)?.bytes ?? 0),
            file_count: usage.get(u.id)?.files ?? 0,
          })),
        )
      }),
    ),

    // Add a member directly. Without a password they get a one-time
    // set-password link on this team's host (returned, and mailed when
    // delivery is possible).
    post(
      "/team/users",
      authed(async c => {
        const userId = authId(c)
        const { team } = teamFor(c.request)
        const body = c.body as {
          email?: string
          name?: string
          username?: string
          password?: string
          team_admin?: boolean
          teamAdmin?: boolean
        }
        const email = body.email?.trim() ?? ""
        if (!email) return json(c, 422, { error: "email is required" })
        const teamAdmin = body.team_admin ?? body.teamAdmin ?? false
        if (typeof teamAdmin !== "boolean") return json(c, 422, { error: "team_admin must be a boolean" })

        // the uniqueness 409 below answers for every team's users
        const rate = await identityRate(db, userId)
        if (!rate.ok) {
          return json(c, 429, { error: "Too many attempts. Try again later.", retry_after: rate.retryAfterSeconds })
        }
        const created = await createTeamUser(db, team, {
          email,
          name: body.name ?? null,
          username: body.username ?? null,
          password: body.password ?? null,
          teamAdmin,
        })
        if (!created.ok) {
          if (created.field) identityConflict(db, c, team.id, created.field, null, "team_admin")
          return json(c, created.status, { error: created.error })
        }

        const link = body.password ? null : await issueSetPasswordLink(db, emailer, hosts, team, created.user)
        logEvent(db, {
          userId,
          teamId: team.id,
          event: "team.user_created",
          metadata: { target: created.user.id, team_admin: teamAdmin, emailed: link?.emailed ?? null },
        })
        return json(c, 201, {
          ...created.user,
          set_password_url: link?.url ?? null,
          emailed: link?.emailed ?? false,
        })
      }),
    ),

    get("/team/users/:id", guard(h.detail)),
    patch("/team/users/:id", authed(h.edit)),
    post("/team/users/:id/suspend", authed(h.suspend)),
    post("/team/users/:id/unsuspend", authed(h.unsuspend)),
    post("/team/users/:id/reset-password", authed(h.resetPassword)),
    post("/team/users/:id/message", authed(h.message)),

    // Immediate hard delete of a member: rows cascade, blobs are dropped.
    del(
      "/team/users/:id",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        if (id === userId) return json(c, 422, { error: "Cannot delete yourself — use Settings" })
        const found = await h.target(c, id)
        if (!found) return json(c, 404, { error: "User not found" })
        if (found.is_owner) return json(c, 422, { error: "Cannot delete an owner" })
        // an admin is first marked deleted under the last-admin check, so a
        // concurrent delete of the other admin counts this one as gone
        if (found.team_admin && !found.deleted_at && !found.suspended_at) {
          const ok = await unlessLastAdmin(db, Number(found.team_id), id, tx =>
            tx.execute(
              from("users")
                .where(q => q("id").equals(id))
                .update({ deleted_at: raw("NOW()") }),
            ),
          )
          if (!ok) return json(c, 422, { error: "Cannot delete the last active admin of a team" })
        }
        await purgeUser(db, store, id)
        logEvent(db, { userId, teamId: Number(found.team_id), event: "team.user_deleted", metadata: { target: id } })
        return json(c, 200, { deleted: id })
      }),
    ),

    get(
      "/team/invites",
      guard(async c => {
        const teamId = teamFor(c.request).team.id
        const filter = c.query.filter ?? "all"
        let q = from("invites")
          .where(p => p("team_id").equals(teamId))
          .select("id", "email", "invited_by", "used_at", "used_by", "created_at")
        if (filter === "unused") q = q.where(p => p("used_at").isNull())
        if (filter === "used") q = q.where(p => p("used_at").isNotNull())
        const rows = (await db.all(q.orderBy("created_at", "DESC").orderBy("id", "DESC").limit(500))) as Array<{
          id: number
          email: string | null
          invited_by: number | null
          used_at: string | null
          used_by: number | null
          created_at: string
        }>

        const userIds = Array.from(
          new Set([
            ...rows.map(r => r.invited_by).filter((x): x is number => x != null),
            ...rows.map(r => r.used_by).filter((x): x is number => x != null),
          ]),
        )
        const users =
          userIds.length === 0
            ? []
            : ((await db.all(
                from("users")
                  .where(p => p("id").inList(userIds))
                  .where(p => p("team_id").equals(teamId))
                  .select("id", "username"),
              )) as Array<{ id: number; username: string }>)
        const byId = new Map(users.map(u => [u.id, u.username]))

        return json(
          c,
          200,
          rows.map(r => ({
            ...r,
            invited_by_username: r.invited_by ? (byId.get(r.invited_by) ?? null) : null,
            used_by_username: r.used_by ? (byId.get(r.used_by) ?? null) : null,
          })),
        )
      }),
    ),

    post(
      "/team/invites",
      authed(async c => {
        const userId = authId(c)
        const teamId = teamFor(c.request).team.id
        const body = c.body as { email?: string }
        const emailRaw = body.email?.trim().toLowerCase()
        if (emailRaw && !isEmail(emailRaw)) return json(c, 422, { error: "Invalid email format" })
        const email = emailRaw || null
        const token = randomToken()
        const rows = (await db.execute(
          from("invites")
            .insert({ token_hash: sha256Hex(token), email, invited_by: userId, team_id: teamId })
            .returning("id", "email", "created_at"),
        )) as Array<{ id: number; email: string | null; created_at: string }>
        return json(c, 201, { ...rows[0], token })
      }),
    ),

    del(
      "/team/invites/:id",
      guard(async c => {
        const teamId = teamFor(c.request).team.id
        const id = Number(c.params.id)
        const row = (await db.one(
          from("invites")
            .where(q => q("id").equals(id))
            .where(q => q("team_id").equals(teamId))
            .select("id", "used_at"),
        )) as { id: number; used_at: string | null } | null
        if (!row) return json(c, 404, { error: "Invite not found" })
        if (row.used_at) return json(c, 409, { error: "Cannot delete a used invite" })
        await db.execute(
          from("invites")
            .where(q => q("id").equals(id))
            .del(),
        )
        return json(c, 200, { deleted: id })
      }),
    ),

    get(
      "/team/audit",
      guard(async c => {
        const teamId = teamFor(c.request).team.id
        const event = c.query.event
        const userIdParam = c.query.user_id ?? c.query.userId
        const limit = Math.min(500, Math.max(1, Number(c.query.limit ?? 100)))

        let q = from("audit_events")
          .leftJoin("users", raw("users.id = audit_events.user_id"))
          .where(qb => qb("audit_events.team_id").equals(teamId))
          .select(
            "audit_events.id",
            "audit_events.user_id",
            "audit_events.event",
            "audit_events.metadata",
            "audit_events.ip",
            "audit_events.user_agent",
            "audit_events.created_at",
            raw("users.username AS username") as any,
            raw("users.email AS user_email") as any,
            raw("users.team_id AS actor_team_id") as any,
          )
          .orderBy("audit_events.created_at", "DESC")
          .orderBy("audit_events.id", "DESC")
          .limit(limit)

        if (event) q = q.where(qb => qb("audit_events.event").equals(event))
        if (userIdParam) {
          const uid = Number(userIdParam)
          if (!Number.isNaN(uid)) q = q.where(qb => qb("audit_events.user_id").equals(uid))
        }
        const rows = (await db.all(q)) as Array<Record<string, unknown> & { actor_team_id: number | null }>
        // the owner's actions on this team are logged here, but who the owner
        // is belongs to root: a team admin sees that the platform acted, not
        // the account, address or network it acted from
        return json(
          c,
          200,
          rows.map(({ actor_team_id, ...row }) =>
            actor_team_id === null || Number(actor_team_id) === teamId
              ? { ...row, actor: null }
              : {
                  ...row,
                  user_id: null,
                  username: null,
                  user_email: null,
                  ip: null,
                  user_agent: null,
                  actor: "Platform admin",
                },
          ),
        )
      }),
    ),
  ]
}
