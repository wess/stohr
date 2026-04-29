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

// Computes active / trash / versions in one round-trip. Each sum is
// served by a partial / covering index added in 00000031_perf_indexes.
export const computeUsage = async (db: Connection, userId: number): Promise<UsageBreakdown> => {
  const rows = await db.execute({
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
  }) as Array<{ active: string | number | null; trash: string | number | null; versions: string | number | null }>
  const r = rows[0]
  const active = Number(r?.active ?? 0)
  const trash = Number(r?.trash ?? 0)
  const versions = Number(r?.versions ?? 0)
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
