import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { halt } from "@atlas/server"

/**
 * Pipeline guard that allows only owner accounts. Re-queries `users.is_owner`
 * on every call rather than trusting the JWT claim, because sessions outlive
 * a demotion and access tokens last up to an hour. The DB is authoritative.
 *
 * One indexed PK lookup per admin request — negligible overhead.
 */
export const ownerOnly = (db: Connection) => async (c: any) => {
  const id = c.assigns?.auth?.id as number | undefined
  if (!id) return halt(c, 403, { error: "Owner access required" })
  const row = await db.one(
    from("users").where(q => q("id").equals(id)).select("is_owner"),
  ) as { is_owner: boolean } | null
  if (!row?.is_owner) return halt(c, 403, { error: "Owner access required" })
  return c
}
