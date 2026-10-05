// Slug -> team lookups sit on every request, so they go through a short
// in-memory cache. Misses are cached too: an unknown subdomain (or a
// certificate probe from Caddy) must not turn into a query per hit. Team
// writes clear the cache; the ttl bounds staleness across api replicas.

import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { isReservedSlug } from "./slug.ts"

export const ROOT_TEAM_ID = 1

export type Team = {
  id: number
  slug: string
  name: string
  custom_domain?: string | null
  domain_verified_at?: string | null
  quota_bytes: number | null
  suspended_at: string | null
  deleted_at: string | null
  created_at: string
}

const TTL_MS = 30_000
const MAX_ENTRIES = 10_000

type Entry = { team: Team | null; expires: number }
const bySlug = new Map<string, Entry>()
const byId = new Map<number, Entry>()

// the driver hands timestamps back as Date objects; keep the wire shape iso
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))

export const teamFromRow = (row: Record<string, unknown>): Team => ({
  id: Number(row.id),
  slug: String(row.slug),
  name: String(row.name),
  custom_domain: row.custom_domain == null ? null : String(row.custom_domain),
  domain_verified_at: iso(row.domain_verified_at),
  quota_bytes: row.quota_bytes == null ? null : Number(row.quota_bytes),
  suspended_at: iso(row.suspended_at),
  deleted_at: iso(row.deleted_at),
  created_at: iso(row.created_at) ?? "",
})

const remember = (team: Team | null, slug: string | null, id: number | null): Team | null => {
  if (bySlug.size > MAX_ENTRIES) bySlug.clear()
  if (byId.size > MAX_ENTRIES) byId.clear()
  const entry = { team, expires: Date.now() + TTL_MS }
  if (slug !== null) bySlug.set(slug, entry)
  if (id !== null) byId.set(id, entry)
  if (team) {
    bySlug.set(team.slug, entry)
    byId.set(team.id, entry)
  }
  return team
}

const live = (entry: Entry | undefined): Entry | null => (entry && entry.expires > Date.now() ? entry : null)

export const clearTeamCache = (slug?: string): void => {
  if (slug === undefined) {
    bySlug.clear()
    byId.clear()
    return
  }
  const entry = bySlug.get(slug)
  bySlug.delete(slug)
  if (entry?.team) byId.delete(entry.team.id)
}

// deleted teams resolve to nothing: their host is gone from the outside.
// Reserved slugs never resolve either — "root" is a real row, but the root
// team is only ever reached by id, never as a subdomain.
export const teamBySlug = async (db: Connection, slug: string): Promise<Team | null> => {
  if (isReservedSlug(slug)) return null
  const hit = live(bySlug.get(slug))
  if (hit) return hit.team
  const row = (await db.one(
    from("teams")
      .where(q => q("slug").equals(slug))
      .where(q => q("deleted_at").isNull()),
  )) as Record<string, unknown> | null
  return remember(row ? teamFromRow(row) : null, slug, null)
}

// by id the deleted flag is returned rather than hidden — admin and purge
// code needs to see soft-deleted rows
export const teamById = async (db: Connection, id: number): Promise<Team | null> => {
  const hit = live(byId.get(id))
  if (hit) return hit.team
  const row = (await db.one(from("teams").where(q => q("id").equals(id)))) as Record<string, unknown> | null
  return remember(row ? teamFromRow(row) : null, null, id)
}

// the row is seeded by the migration; the sentinel only covers a database
// that has not run it yet, so boot and health checks never hard-fail here
const ROOT_SENTINEL: Team = {
  id: ROOT_TEAM_ID,
  slug: "root",
  name: "Stohr",
  quota_bytes: null,
  suspended_at: null,
  deleted_at: null,
  created_at: new Date(0).toISOString(),
}

export const rootTeam = async (db: Connection): Promise<Team> => (await teamById(db, ROOT_TEAM_ID)) ?? ROOT_SENTINEL

export const rootSentinel = (): Team => ROOT_SENTINEL

export const teamByDomain = async (db: Connection, domain: string): Promise<Team | null> => {
  const row = (await db.one({
    text: "SELECT * FROM teams WHERE custom_domain = $1 AND domain_verified_at IS NOT NULL AND deleted_at IS NULL",
    values: [domain],
  })) as Record<string, unknown> | null
  return row ? teamFromRow(row) : null
}
