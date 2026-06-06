import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { getInstanceKeys } from "./keys.ts"
import type { MemberRow } from "./membership.ts"

// Placement selects which peers (including possibly self) hold copies or
// shards of a new federation blob. The MVP rule set:
//   1. Always prefer peers with the lowest used_bytes / contributed_bytes ratio.
//   2. Tie-break on most recently seen (live peers first).
//   3. Skip draining or left peers.
//   4. Require enough capacity remaining (contributed_bytes - used_bytes >= size).
// If we don't have N viable peers, return what we have — the caller decides
// whether to proceed (degraded replication) or fail.

export type Placement = {
  members: MemberRow[]
  selfIncluded: boolean
  shortBy: number
}

const utilization = (m: MemberRow): number => {
  const c = Number(m.contributed_bytes)
  if (c <= 0) return Infinity
  return Number(m.used_bytes) / c
}

const hasCapacity = (m: MemberRow, size: number): boolean => {
  const c = Number(m.contributed_bytes)
  if (c <= 0) return false
  return c - Number(m.used_bytes) >= size
}

export const selectPlacement = async (
  db: Connection,
  federationId: number,
  count: number,
  size: number,
  excludePubkeys: Set<string> = new Set(),
): Promise<Placement> => {
  const members = (await db.all(
    from("federation_members")
      .where(q => q("federation_id").equals(federationId))
      .where(q => q("status").equals("active")),
  )) as MemberRow[]

  const ranked = members
    .filter(m => !excludePubkeys.has(m.peer_pubkey))
    .filter(m => hasCapacity(m, size))
    .sort((a, b) => {
      const ua = utilization(a)
      const ub = utilization(b)
      if (ua !== ub) return ua - ub
      // tie-break: prefer recent last_seen (active liveness)
      const sa = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0
      const sb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0
      return sb - sa
    })

  const selected = ranked.slice(0, count)
  const selfKey = (await getInstanceKeys(db)).ed25519PublicRaw
  return {
    members: selected,
    selfIncluded: selected.some(m => m.peer_pubkey === selfKey),
    shortBy: Math.max(0, count - selected.length),
  }
}

export const isSelf = async (db: Connection, pubkeyRaw: string): Promise<boolean> => {
  const keys = await getInstanceKeys(db)
  return keys.ed25519PublicRaw === pubkeyRaw
}
