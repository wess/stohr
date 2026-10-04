// Owner-only control plane for teams, on the root host. Creating a team
// also creates its first admin and hands back the one-time link that sets
// their password on the team's own subdomain.

import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { del, get, json, parseJson, patch, pipeline, post } from "@atlas/server"
import { purgeUser } from "../auth/deletion.ts"
import { requireAuth } from "../auth/guard.ts"
import type { Emailer } from "../email/index.ts"
import { logEvent } from "../security/audit.ts"
import { ownerOnly } from "../security/owner.ts"
import type { StorageHandle } from "../storage/index.ts"
import { computeTeamUsage, countTeamUsers } from "./members.ts"
import type { Team } from "./resolve.ts"
import { clearTeamCache, ROOT_TEAM_ID, teamFromRow as toTeam } from "./resolve.ts"
import { normalizeSlug, slugProblem } from "./slug.ts"
import type { HostConfig } from "./urls.ts"
import { teamBaseUrl } from "./urls.ts"
import { createTeamUser, issueSetPasswordLink } from "./users.ts"

const authId = (c: Conn) => (c.assigns.auth as { id: number }).id

// same grace window as account deletion
const GRACE_HOURS = 24

const parseQuota = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined
  if (v === null || v === 0) return null
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined
  return Math.floor(v)
}

const withStats = async (db: Connection, team: Team, hosts: HostConfig) => ({
  ...team,
  base_url: teamBaseUrl(team, hosts),
  user_count: await countTeamUsers(db, team.id),
  usage: await computeTeamUsage(db, team.id),
})

export const adminTeamRoutes = (db: Connection, secret: string, emailer: Emailer, hosts: HostConfig) => {
  const ownerCheck = ownerOnly(db)
  const guard = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck)
  const authed = pipeline(requireAuth({ secret, db, noOAuth: true }), ownerCheck, parseJson)

  const load = async (c: Conn): Promise<Team | null> => {
    const id = Number(c.params.id)
    if (!Number.isInteger(id)) return null
    // straight from the table: the admin surface must never see a stale cache
    const row = (await db.one(from("teams").where(q => q("id").equals(id)))) as Record<string, unknown> | null
    return row ? toTeam(row) : null
  }

  return [
    get(
      "/admin/teams",
      guard(async c => {
        const filter = c.query.filter ?? "live"
        let q = from("teams").orderBy("id", "ASC")
        if (filter === "deleted") q = q.where(p => p("deleted_at").isNotNull())
        else if (filter !== "all") q = q.where(p => p("deleted_at").isNull())
        const rows = (await db.all(q)) as Array<Record<string, unknown>>
        return json(c, 200, await Promise.all(rows.map(r => withStats(db, toTeam(r), hosts))))
      }),
    ),

    post(
      "/admin/teams",
      authed(async c => {
        const userId = authId(c)
        const body = c.body as {
          slug?: string
          name?: string
          quota_bytes?: number | null
          quotaBytes?: number | null
          admin_email?: string
          adminEmail?: string
          admin_name?: string
          adminName?: string
          admin_username?: string
          adminUsername?: string
        }
        if (!hosts.rootDomain) {
          return json(c, 422, { error: "ROOT_DOMAIN is not set; teams need host routing to be reachable" })
        }
        const slug = normalizeSlug(body.slug ?? "")
        const problem = slugProblem(slug)
        if (problem) return json(c, 422, { error: problem })
        const name = body.name?.trim() || slug
        const quota = parseQuota(body.quota_bytes ?? body.quotaBytes)
        if (quota === undefined && (body.quota_bytes ?? body.quotaBytes) !== undefined) {
          return json(c, 422, { error: "quota_bytes must be a non-negative number (0 or null = unlimited)" })
        }
        const adminEmail = (body.admin_email ?? body.adminEmail ?? "").trim().toLowerCase()
        if (!adminEmail) return json(c, 422, { error: "admin_email is required" })

        // includes soft-deleted teams: the slug is spoken for until the purge
        const taken = await db.one(
          from("teams")
            .where(q => q("slug").equals(slug))
            .select("id"),
        )
        if (taken) return json(c, 409, { error: "Slug already in use" })

        const inserted = (await db.execute(
          from("teams")
            .insert({ slug, name, quota_bytes: quota ?? null })
            .returning("id", "slug", "name", "quota_bytes", "suspended_at", "deleted_at", "created_at"),
        )) as Array<Record<string, unknown>>
        const team = toTeam(inserted[0]!)

        const created = await createTeamUser(db, team, {
          email: adminEmail,
          name: body.admin_name ?? body.adminName ?? null,
          username: body.admin_username ?? body.adminUsername ?? null,
          teamAdmin: true,
        })
        if (!created.ok) {
          // a team without an admin is unreachable; undo rather than leave it
          await db.execute(
            from("teams")
              .where(q => q("id").equals(team.id))
              .del(),
          )
          return json(c, created.status, { error: created.error })
        }
        const link = await issueSetPasswordLink(db, emailer, hosts, team, created.user)

        logEvent(db, {
          userId,
          teamId: ROOT_TEAM_ID,
          event: "admin.team_created",
          metadata: { team_id: team.id, slug, admin_user_id: created.user.id, emailed: link.emailed },
        })
        return json(c, 201, {
          team: await withStats(db, team, hosts),
          admin: created.user,
          set_password_url: link.url,
          emailed: link.emailed,
        })
      }),
    ),

    get(
      "/admin/teams/:id",
      guard(async c => {
        const team = await load(c)
        if (!team) return json(c, 404, { error: "Team not found" })
        return json(c, 200, await withStats(db, team, hosts))
      }),
    ),

    patch(
      "/admin/teams/:id",
      authed(async c => {
        const userId = authId(c)
        const team = await load(c)
        if (!team) return json(c, 404, { error: "Team not found" })
        const body = c.body as {
          name?: string
          quota_bytes?: number | null
          quotaBytes?: number | null
          suspended?: boolean
        }
        const update: Record<string, unknown> = {}

        if (body.name !== undefined) {
          const name = body.name.trim()
          if (!name) return json(c, 422, { error: "name must not be empty" })
          update.name = name
        }
        // null is a value here (unlimited), so no `??`
        const quotaIn = "quota_bytes" in body ? body.quota_bytes : body.quotaBytes
        if (quotaIn !== undefined) {
          const quota = parseQuota(quotaIn)
          if (quota === undefined) {
            return json(c, 422, { error: "quota_bytes must be a non-negative number (0 or null = unlimited)" })
          }
          update.quota_bytes = quota
        }
        if (body.suspended !== undefined) {
          if (typeof body.suspended !== "boolean") return json(c, 422, { error: "suspended must be a boolean" })
          if (team.id === ROOT_TEAM_ID && body.suspended)
            return json(c, 422, { error: "The root team cannot be suspended" })
          update.suspended_at = body.suspended ? raw("NOW()") : null
        }
        if (Object.keys(update).length === 0) return json(c, 422, { error: "Nothing to update" })

        await db.execute(
          from("teams")
            .where(q => q("id").equals(team.id))
            .update(update),
        )
        clearTeamCache(team.slug)
        logEvent(db, {
          userId,
          teamId: ROOT_TEAM_ID,
          event: "admin.team_edited",
          metadata: { team_id: team.id, fields: Object.keys(update) },
        })
        const fresh = await load(c)
        return json(c, 200, fresh ? await withStats(db, fresh, hosts) : { id: team.id })
      }),
    ),

    // Soft delete: the host stops resolving at once; users, files and blobs
    // go with the purge sweep after the grace window, like a deleted account.
    del(
      "/admin/teams/:id",
      guard(async c => {
        const userId = authId(c)
        const team = await load(c)
        if (!team) return json(c, 404, { error: "Team not found" })
        if (team.id === ROOT_TEAM_ID) return json(c, 422, { error: "The root team cannot be deleted" })
        if (team.deleted_at) return json(c, 409, { error: "Team is already scheduled for deletion" })
        await db.execute(
          from("teams")
            .where(q => q("id").equals(team.id))
            .update({ deleted_at: raw("NOW()") }),
        )
        clearTeamCache(team.slug)
        logEvent(db, { userId, teamId: ROOT_TEAM_ID, event: "admin.team_deleted", metadata: { team_id: team.id } })
        return json(c, 200, { id: team.id, deleted: true, purge_after_hours: GRACE_HOURS })
      }),
    ),

    post(
      "/admin/teams/:id/restore",
      guard(async c => {
        const userId = authId(c)
        const team = await load(c)
        if (!team) return json(c, 404, { error: "Team not found" })
        if (!team.deleted_at) return json(c, 409, { error: "Team is not scheduled for deletion" })
        await db.execute(
          from("teams")
            .where(q => q("id").equals(team.id))
            .update({ deleted_at: null }),
        )
        clearTeamCache(team.slug)
        logEvent(db, { userId, teamId: ROOT_TEAM_ID, event: "admin.team_restored", metadata: { team_id: team.id } })
        return json(c, 200, { id: team.id, deleted: false })
      }),
    ),
  ]
}

// Purge teams whose grace window has elapsed: every member goes through the
// account hard-delete path (rows cascade, blobs dropped), then the team row.
// invites cascade on the team fk; audit rows keep their history with the
// team_id nulled.
export const sweepDeletedTeams = async (db: Connection, store: StorageHandle): Promise<void> => {
  const expired = (await db.all(
    from("teams")
      .where(q => q("deleted_at").isNotNull())
      .where(q => q("deleted_at").lessThan(raw(`NOW() - INTERVAL '${GRACE_HOURS} hours'`)))
      .where(q => q("id").notEquals(ROOT_TEAM_ID))
      .select("id", "slug"),
  )) as Array<{ id: number; slug: string }>

  for (const team of expired) {
    try {
      const users = (await db.all(
        from("users")
          .where(q => q("team_id").equals(team.id))
          .select("id"),
      )) as Array<{ id: number }>
      for (const u of users) await purgeUser(db, store, u.id)
      await db.execute(
        from("teams")
          .where(q => q("id").equals(team.id))
          .del(),
      )
      clearTeamCache(team.slug)
    } catch (err) {
      console.error(`[teams] purge failed for team ${team.id}:`, err)
    }
  }
}
