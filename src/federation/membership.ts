import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { getInstanceKeys, pubPemToRaw } from "./keys.ts"

export type FederationRow = {
  id: number
  slug: string
  name: string
  description: string | null
  type: "content-sharing" | "space-offering"
  public_key: string
  private_key: string | null
  replication_factor: number
  erasure_k: number | null
  erasure_m: number | null
  quota_multiplier: string
  group_key_encrypted: string | null
  created_by: number | null
  created_at: string
}

export type MemberRow = {
  id: number
  federation_id: number
  user_id: number | null
  peer_pubkey: string
  peer_x25519_pubkey: string | null
  peer_base_url: string
  display_name: string | null
  is_local: boolean
  is_admin: boolean
  contributed_bytes: string | number
  used_bytes: string | number
  status: "active" | "draining" | "left"
  joined_at: string
  last_seen_at: string | null
}

export const federationById = async (db: Connection, id: number): Promise<FederationRow | null> =>
  (await db.one(from("federations").where(q => q("id").equals(id)))) as FederationRow | null

export const federationBySlug = async (db: Connection, slug: string): Promise<FederationRow | null> =>
  (await db.one(from("federations").where(q => q("slug").equals(slug)))) as FederationRow | null

export const membersForFederation = async (db: Connection, federationId: number): Promise<MemberRow[]> =>
  (await db.all(
    from("federation_members")
      .where(q => q("federation_id").equals(federationId))
      .where(q => q("status").equals("active"))
      .orderBy("joined_at", "ASC"),
  )) as MemberRow[]

export const remoteMembersForFederation = async (db: Connection, federationId: number): Promise<MemberRow[]> =>
  (await db.all(
    from("federation_members")
      .where(q => q("federation_id").equals(federationId))
      .where(q => q("is_local").equals(false))
      .where(q => q("status").equals("active")),
  )) as MemberRow[]

export const localMemberFor = async (db: Connection, federationId: number, userId: number): Promise<MemberRow | null> =>
  (await db.one(
    from("federation_members")
      .where(q => q("federation_id").equals(federationId))
      .where(q => q("user_id").equals(userId))
      .where(q => q("is_local").equals(true)),
  )) as MemberRow | null

export const federationsForUser = async (
  db: Connection,
  userId: number,
): Promise<Array<FederationRow & { local_member: MemberRow }>> => {
  const rows = (await db.execute({
    text: `
      SELECT f.*, m.id AS m_id, m.user_id AS m_user_id, m.peer_pubkey AS m_peer_pubkey,
             m.peer_base_url AS m_peer_base_url, m.is_admin AS m_is_admin,
             m.contributed_bytes AS m_contributed_bytes, m.used_bytes AS m_used_bytes,
             m.status AS m_status, m.joined_at AS m_joined_at
        FROM federations f
        JOIN federation_members m ON m.federation_id = f.id
       WHERE m.user_id = $1 AND m.is_local = TRUE
       ORDER BY f.created_at DESC
    `,
    values: [userId],
  })) as Array<Record<string, unknown>>
  return rows.map(r => ({
    id: r.id as number,
    slug: r.slug as string,
    name: r.name as string,
    description: r.description as string | null,
    type: r.type as FederationRow["type"],
    public_key: r.public_key as string,
    private_key: r.private_key as string | null,
    replication_factor: r.replication_factor as number,
    erasure_k: r.erasure_k as number | null,
    erasure_m: r.erasure_m as number | null,
    quota_multiplier: String(r.quota_multiplier),
    group_key_encrypted: r.group_key_encrypted as string | null,
    created_by: r.created_by as number | null,
    created_at: String(r.created_at),
    local_member: {
      id: r.m_id as number,
      federation_id: r.id as number,
      user_id: r.m_user_id as number | null,
      peer_pubkey: r.m_peer_pubkey as string,
      peer_x25519_pubkey: null,
      peer_base_url: r.m_peer_base_url as string,
      display_name: null,
      is_local: true,
      is_admin: r.m_is_admin as boolean,
      contributed_bytes: r.m_contributed_bytes as number | string,
      used_bytes: r.m_used_bytes as number | string,
      status: r.m_status as MemberRow["status"],
      joined_at: String(r.m_joined_at),
      last_seen_at: null,
    },
  }))
}

// "Are we one of the admins of this federation?" — used to gate invite
// minting, member removal, etc. The MVP uses a simple boolean; multi-admin
// quorum is a future enhancement.
export const isLocalAdmin = async (db: Connection, federationId: number, userId: number): Promise<boolean> => {
  const m = await db.one(
    from("federation_members")
      .where(q => q("federation_id").equals(federationId))
      .where(q => q("user_id").equals(userId))
      .where(q => q("is_local").equals(true))
      .where(q => q("is_admin").equals(true))
      .select("id"),
  )
  return !!m
}

// Convenience to derive this instance's pubkey raw for storage in member
// rows. The instance keys are persisted, so callers can rely on the value
// being stable across calls.
export const instancePubkeyRaw = async (db: Connection): Promise<string> => {
  const k = await getInstanceKeys(db)
  return k.ed25519PublicRaw
}

export const fedPublicKeyRaw = (fed: FederationRow): string => pubPemToRaw(fed.public_key)
