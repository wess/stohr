// Every upload path pre-checks quota, writes, then reads usage again: the
// pre-check raced with every other write since, so two concurrent uploads
// can both pass it. This is the second read, for both caps; the caller undoes
// its own write when it comes back non-null.

import type { Connection } from "@atlas/db"
import type { QuotaDenied } from "../usage/index.ts"
import { computeUsage, teamOverQuota } from "../usage/index.ts"

export const quotaAfterWrite = async (
  db: Connection,
  ownerId: number,
  quotaBytes: number,
  attemptedBytes: number,
): Promise<QuotaDenied | null> => {
  if (quotaBytes > 0) {
    const usage = await computeUsage(db, ownerId)
    if (usage.total > quotaBytes) {
      return {
        ok: false,
        scope: "user",
        quota_bytes: quotaBytes,
        used_bytes: usage.total,
        attempted_bytes: attemptedBytes,
        breakdown: usage,
      }
    }
  }
  const team = await teamOverQuota(db, ownerId)
  return team ? { ...team, attempted_bytes: attemptedBytes } : null
}

export const quotaMessage = (scope: "user" | "team"): string =>
  scope === "team" ? "Team storage quota exceeded" : "Storage quota exceeded"
