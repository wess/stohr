import type { Connection } from "@atlas/db"

export type UsageBreakdown = {
  /** Bytes in current (non-trashed) files. */
  active: number
  /** Bytes in soft-deleted files still recoverable from /trash. */
  trash: number
  /** Bytes in archived prior versions. */
  versions: number
  /** active + trash + versions — what billing actually charges for. */
  total: number
}

const sumSize = async (db: Connection, sql: string, values: any[]): Promise<number> => {
  const rows = await db.execute({ text: sql, values }) as Array<{ total: string | number | null }>
  return Number(rows[0]?.total ?? 0)
}

export const computeUsage = async (db: Connection, userId: number): Promise<UsageBreakdown> => {
  const active = await sumSize(
    db,
    "SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE user_id = $1 AND deleted_at IS NULL",
    [userId],
  )
  const trash = await sumSize(
    db,
    "SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL",
    [userId],
  )
  const versions = await sumSize(
    db,
    `SELECT COALESCE(SUM(fv.size), 0) AS total
     FROM file_versions fv
     JOIN files f ON f.id = fv.file_id
     WHERE f.user_id = $1`,
    [userId],
  )
  return { active, trash, versions, total: active + trash + versions }
}

/**
 * Quota check for a write that would add `incomingBytes` to the user's storage.
 * Returns null if allowed, or a structured error payload if it would exceed quota.
 * A quota of 0 (or negative) means unlimited.
 */
export const checkQuota = async (
  db: Connection,
  userId: number,
  quotaBytes: number,
  incomingBytes: number,
): Promise<{ ok: true } | { ok: false; quota_bytes: number; used_bytes: number; attempted_bytes: number; breakdown: UsageBreakdown }> => {
  if (!quotaBytes || quotaBytes <= 0) return { ok: true }
  const breakdown = await computeUsage(db, userId)
  if (breakdown.total + incomingBytes > quotaBytes) {
    return {
      ok: false,
      quota_bytes: quotaBytes,
      used_bytes: breakdown.total,
      attempted_bytes: incomingBytes,
      breakdown,
    }
  }
  return { ok: true }
}
