import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn, Route } from "@atlas/server"
import { halt } from "@atlas/server"
import { teamFor } from "./request.ts"
import { ROOT_TEAM_ID } from "./resolve.ts"

// Surfaces that only exist on the root host (federation, external login,
// instance settings) are not found elsewhere — a tenant host should look
// like it has no such feature, not like it is forbidden.
export const rootOnly = (c: Conn): Conn => (teamFor(c.request).isRoot ? c : halt(c, 404, { error: "Not found" }))

// same rule for routes built by a library we cannot put a pipe in front of
export const rootOnlyRoutes = (routes: readonly Route[]): Route[] =>
  routes.map(r => ({
    ...r,
    handler: async (c: Conn) => (teamFor(c.request).isRoot ? r.handler(c) : halt(c, 404, { error: "Not found" })),
  }))

// Pipeline guard for /team/*: a team admin of the host's team, or the
// instance owner (who only ever gets here on the root host, since
// requireAuth already pinned the caller's team to the host). DB-backed
// like ownerOnly — a demotion must bite before the session expires.
export const teamAdminOnly = (db: Connection) => async (c: Conn) => {
  const id = (c.assigns.auth as { id?: number } | undefined)?.id
  if (!id) return halt(c, 403, { error: "Team admin access required" })
  const host = teamFor(c.request)
  const row = (await db.one(
    from("users")
      .where(q => q("id").equals(id))
      .select("is_owner", "team_admin", "team_id"),
  )) as { is_owner: boolean; team_admin: boolean; team_id: number } | null
  if (!row || row.team_id !== host.team.id) return halt(c, 403, { error: "Team admin access required" })
  if (row.team_admin) return c
  if (row.is_owner && row.team_id === ROOT_TEAM_ID) return c
  return halt(c, 403, { error: "Team admin access required" })
}
