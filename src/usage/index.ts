import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { computeTeamUsage, type TeamUsage } from "../teams/members.ts"

export type UsageBreakdown = {
  /** Bytes in current (non-trashed) files. */
  active: number
  /** Bytes in soft-deleted files still recoverable from /trash. */
  trash: number
  /** Bytes in archived prior versions. */
  versions: number
  /** active + trash + versions — what a storage cap is measured against. */
  total: number
}

// Computes active / trash / versions in one round-trip. Each sum is
// served by a partial / covering index added in 00000031_perf_indexes.
export const computeUsage = async (db: Connection, userId: number): Promise<UsageBreakdown> => {
  const rows = (await db.execute({
    text: `
      SELECT
        COALESCE((SELECT SUM(size) FROM files
                   WHERE user_id = $1 AND deleted_at IS NULL), 0)     AS active,
        COALESCE((SELECT SUM(size) FROM files
                   WHERE user_id = $1 AND deleted_at IS NOT NULL), 0) AS trash,
        COALESCE((SELECT SUM(fv.size)
                    FROM file_versions fv
                    JOIN files f ON f.id = fv.file_id
                   WHERE f.user_id = $1), 0)                          AS versions
    `,
    values: [userId],
  })) as Array<{ active: string | number | null; trash: string | number | null; versions: string | number | null }>
  const r = rows[0]
  const active = Number(r?.active ?? 0)
  const trash = Number(r?.trash ?? 0)
  const versions = Number(r?.versions ?? 0)
  return { active, trash, versions, total: active + trash + versions }
}

// The per-user cap; 0 means unlimited.
export const userQuota = async (db: Connection, userId: number): Promise<number> => {
  const row = (await db.one(
    from("users")
      .where(q => q("id").equals(userId))
      .select("storage_quota_bytes"),
  )) as { storage_quota_bytes: number | string } | null
  return Number(row?.storage_quota_bytes ?? 0)
}

// The cap on the user's whole team; 0 means unlimited (teams.quota_bytes NULL).
export const teamQuotaOf = async (db: Connection, userId: number): Promise<{ teamId: number; quota: number }> => {
  const row = (await db.one({
    text: `SELECT t.id, t.quota_bytes FROM users u JOIN teams t ON t.id = u.team_id WHERE u.id = $1`,
    values: [userId],
  })) as { id: number; quota_bytes: number | string | null } | null
  return { teamId: Number(row?.id ?? 1), quota: Number(row?.quota_bytes ?? 0) }
}

export type QuotaDenied = {
  ok: false
  // which cap was hit
  scope: "user" | "team"
  quota_bytes: number
  used_bytes: number
  attempted_bytes: number
  breakdown: UsageBreakdown | TeamUsage
}

/**
 * Quota check for a write that would add `incomingBytes` to the user's storage.
 * Returns null if allowed, or a structured error payload if it would exceed the
 * cap. Two caps apply: the per-user `storage_quota_bytes` column (set by the
 * owner in Admin; 0 = unlimited) and the user's team `quota_bytes`, measured
 * against the sum of every member's usage (NULL = unlimited).
 */
export const checkQuota = async (
  db: Connection,
  userId: number,
  quotaBytes: number,
  incomingBytes: number,
): Promise<{ ok: true } | QuotaDenied> => {
  if (quotaBytes > 0) {
    const breakdown = await computeUsage(db, userId)
    if (breakdown.total + incomingBytes > quotaBytes) {
      return {
        ok: false,
        scope: "user",
        quota_bytes: quotaBytes,
        used_bytes: breakdown.total,
        attempted_bytes: incomingBytes,
        breakdown,
      }
    }
  }
  const team = await teamQuotaOf(db, userId)
  if (team.quota > 0) {
    const breakdown = await computeTeamUsage(db, team.teamId)
    if (breakdown.total + incomingBytes > team.quota) {
      return {
        ok: false,
        scope: "team",
        quota_bytes: team.quota,
        used_bytes: breakdown.total,
        attempted_bytes: incomingBytes,
        breakdown,
      }
    }
  }
  return { ok: true }
}

// Post-write re-check for the team cap, the counterpart of the per-user
// `computeUsage(...).total > quota` test upload handlers already run to close
// the window between two concurrent uploads. Null when within the cap.
export const teamOverQuota = async (db: Connection, userId: number): Promise<QuotaDenied | null> => {
  const team = await teamQuotaOf(db, userId)
  if (team.quota <= 0) return null
  const breakdown = await computeTeamUsage(db, team.teamId)
  if (breakdown.total <= team.quota) return null
  return {
    ok: false,
    scope: "team",
    quota_bytes: team.quota,
    used_bytes: breakdown.total,
    attempted_bytes: 0,
    breakdown,
  }
}
