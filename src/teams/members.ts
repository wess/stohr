// Membership lookups other modules build on: anything that reads another
// user (search, collaborators, messages, admin lists) must stay inside the
// caller's team, and these are the checks to do it with.

import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { ROOT_TEAM_ID } from "./resolve.ts"

export const teamIdOf = async (db: Connection, userId: number): Promise<number | null> => {
  const row = (await db.one(
    from("users")
      .where(q => q("id").equals(userId))
      .select("team_id"),
  )) as { team_id: number } | null
  return row ? Number(row.team_id) : null
}

export const userInTeam = async (db: Connection, userId: number, teamId: number): Promise<boolean> => {
  const row = (await db.one(
    from("users")
      .where(q => q("id").equals(userId))
      .where(q => q("team_id").equals(teamId))
      .select("id"),
  )) as { id: number } | null
  return row !== null
}

// false when either user is missing — never "same" by accident
export const sameTeam = async (db: Connection, a: number, b: number): Promise<boolean> => {
  if (a === b) return (await teamIdOf(db, a)) !== null
  const rows = (await db.all(
    from("users")
      .where(q => q("id").inList([a, b]))
      .select("id", "team_id"),
  )) as Array<{ id: number; team_id: number }>
  if (rows.length !== 2) return false
  return Number(rows[0]!.team_id) === Number(rows[1]!.team_id)
}

// `users.id IN (<team X>)` as a raw fragment for ad-hoc sql — the id is
// coerced so nothing user-controlled is ever interpolated
export const usersInTeamSql = (teamId: number): string =>
  `(SELECT id FROM users WHERE team_id = ${Math.floor(Number(teamId))})`

// query-builder form: `.where(inTeam("user_id", teamId))`; the column is a
// code-controlled identifier, never request input
export const inTeam =
  (column: string, teamId: number) =>
  (q: any): any =>
    q.raw(raw(`${column} IN ${usersInTeamSql(teamId)}`))

export type TeamUsage = { active: number; trash: number; versions: number; total: number }

// bytes across every member, same breakdown as the per-user computeUsage
export const computeTeamUsage = async (db: Connection, teamId: number): Promise<TeamUsage> => {
  const rows = (await db.execute({
    text: `
      SELECT
        COALESCE((SELECT SUM(size) FROM files
                   WHERE deleted_at IS NULL
                     AND user_id IN (SELECT id FROM users WHERE team_id = $1)), 0)     AS active,
        COALESCE((SELECT SUM(size) FROM files
                   WHERE deleted_at IS NOT NULL
                     AND user_id IN (SELECT id FROM users WHERE team_id = $1)), 0)     AS trash,
        COALESCE((SELECT SUM(fv.size)
                    FROM file_versions fv
                    JOIN files f ON f.id = fv.file_id
                   WHERE f.user_id IN (SELECT id FROM users WHERE team_id = $1)), 0)  AS versions
    `,
    values: [teamId],
  })) as Array<{ active: string | number | null; trash: string | number | null; versions: string | number | null }>
  const r = rows[0]
  const active = Number(r?.active ?? 0)
  const trash = Number(r?.trash ?? 0)
  const versions = Number(r?.versions ?? 0)
  return { active, trash, versions, total: active + trash + versions }
}

export const countTeamUsers = async (db: Connection, teamId: number): Promise<number> => {
  const row = (await db.one({
    text: "SELECT COUNT(*)::int AS n FROM users WHERE team_id = $1 AND deleted_at IS NULL",
    values: [teamId],
  })) as { n: number } | null
  return Number(row?.n ?? 0)
}

// admins who can still act: not suspended, not pending deletion
export const countActiveTeamAdmins = async (db: Connection, teamId: number): Promise<number> => {
  const row = (await db.one({
    text: `SELECT COUNT(*)::int AS n FROM users
            WHERE team_id = $1 AND team_admin = TRUE AND deleted_at IS NULL AND suspended_at IS NULL`,
    values: [teamId],
  })) as { n: number } | null
  return Number(row?.n ?? 0)
}

// Demoting, suspending or deleting an admin must leave someone who can
// still administer the team. Two admins removing each other at the same
// time would each count the other as active, so the count and the write
// share one transaction under the team row's lock; the second one in sees
// the first one's write. On root the owner always counts. Resolves false,
// with nothing written, when the target is the last admin standing.
export const unlessLastAdmin = async (
  db: Connection,
  teamId: number,
  targetId: number,
  write: (tx: Connection) => Promise<unknown>,
): Promise<boolean> =>
  db.transaction(async tx => {
    await tx.execute({ text: "SELECT id FROM teams WHERE id = $1 FOR UPDATE", values: [teamId] })
    const row = (await tx.one({
      text: `SELECT COUNT(*)::int AS n FROM users
              WHERE team_id = $1 AND id <> $2 AND deleted_at IS NULL AND suspended_at IS NULL
                AND (team_admin = TRUE OR (is_owner = TRUE AND team_id = $3))`,
      values: [teamId, targetId, ROOT_TEAM_ID],
    })) as { n: number } | null
    if (Number(row?.n ?? 0) < 1) return false
    await write(tx)
    return true
  })
