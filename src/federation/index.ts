import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { logEvent } from "../security/audit.ts"
import { requireSettingEnabled, SETTING_FEDERATION_ENABLED } from "../settings/index.ts"
import { generateEd25519, getInstanceKeys, pubPemToRaw, randomToken } from "./keys.ts"
import { generateSymmetricKey, sealForX25519 } from "./crypto.ts"
import { federationById, federationBySlug, federationsForUser, isLocalAdmin, localMemberFor, membersForFederation } from "./membership.ts"
import { mintInvite, parseInvite } from "./invites.ts"
import { callPair } from "./pairing.ts"

const authId = (c: any) => (c.assigns.auth as { id: number }).id

const ALLOWED_TYPES = new Set(["content-sharing", "space-offering"])
const slugRegex = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/

type CreateBody = {
  slug?: string
  name?: string
  description?: string
  type?: string
  replication_factor?: number
  erasure_k?: number
  erasure_m?: number
  quota_multiplier?: number
}

type InviteBody = {
  ttl_hours?: number
}

type AcceptBody = {
  invite?: string
  display_name?: string
}

export const federationRoutes = (db: Connection, secret: string, publicBaseUrl: string) => {
  const gate = requireSettingEnabled(db, SETTING_FEDERATION_ENABLED)
  const guard = pipeline(gate, requireAuth({ secret, db, noOAuth: true }))
  const authed = pipeline(gate, requireAuth({ secret, db, noOAuth: true }), parseJson)

  return [
    get("/me/federations", guard(async (c) => {
      const userId = authId(c)
      const list = await federationsForUser(db, userId)
      const stripped = list.map(({ private_key: _pk, group_key_encrypted: _gk, ...rest }) => rest)
      return json(c, 200, stripped)
    })),

    post("/me/federations", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as CreateBody
      const slug = (body.slug ?? "").trim().toLowerCase()
      const name = (body.name ?? "").trim()
      const type = (body.type ?? "content-sharing").trim()
      if (!slug || !slugRegex.test(slug)) return json(c, 422, { error: "Invalid slug (lowercase alphanumeric + hyphens, 3-64 chars)" })
      if (!name) return json(c, 422, { error: "Name required" })
      if (!ALLOWED_TYPES.has(type)) return json(c, 422, { error: "type must be content-sharing or space-offering" })

      const existing = await federationBySlug(db, slug)
      if (existing) return json(c, 409, { error: "Federation slug already in use" })

      const replicationFactor = Number.isFinite(body.replication_factor) ? Number(body.replication_factor) : 3
      if (replicationFactor < 1 || replicationFactor > 16) return json(c, 422, { error: "replication_factor must be 1-16" })
      const erasureK = type === "space-offering" ? Number(body.erasure_k ?? 10) : null
      const erasureM = type === "space-offering" ? Number(body.erasure_m ?? 16) : null
      if (erasureK !== null && erasureM !== null) {
        if (erasureK < 1 || erasureM < erasureK || erasureM > 32) {
          return json(c, 422, { error: "erasure params: 1 ≤ k ≤ m ≤ 32" })
        }
      }
      const quotaMultiplier = Number.isFinite(body.quota_multiplier) ? Number(body.quota_multiplier) : 1
      if (quotaMultiplier < 1 || quotaMultiplier > 10) return json(c, 422, { error: "quota_multiplier must be 1-10" })

      const fedKeys = generateEd25519()
      const instanceKeys = await getInstanceKeys(db)

      let groupKeySealed: string | null = null
      if (type === "content-sharing") {
        // Self-sealed group key — only members get a copy decryptable with
        // their own X25519 private. Storing it self-sealed means we don't
        // hold the plaintext at rest either.
        const gk = generateSymmetricKey()
        groupKeySealed = sealForX25519(instanceKeys.x25519PublicRaw, gk)
        gk.fill(0)
      }

      const inserted = await db.execute(
        from("federations").insert({
          slug,
          name,
          description: (body.description ?? "").trim() || null,
          type,
          public_key: fedKeys.publicPem,
          private_key: fedKeys.privatePem,
          replication_factor: replicationFactor,
          erasure_k: erasureK,
          erasure_m: erasureM,
          quota_multiplier: String(quotaMultiplier),
          group_key_encrypted: groupKeySealed,
          created_by: userId,
        }).returning("id", "slug", "name", "type", "created_at"),
      ) as Array<{ id: number; slug: string; name: string; type: string; created_at: string }>

      const fed = inserted[0]!

      // The creator is both an admin and the first local member.
      await db.execute(
        from("federation_members").insert({
          federation_id: fed.id,
          user_id: userId,
          peer_pubkey: instanceKeys.ed25519PublicRaw,
          peer_x25519_pubkey: instanceKeys.x25519PublicRaw,
          peer_base_url: publicBaseUrl,
          is_local: true,
          is_admin: true,
          contributed_bytes: 0,
          used_bytes: 0,
          status: "active",
        }),
      )

      logEvent(db, { userId, event: "federation.created", metadata: { federation_id: fed.id, slug, type } })
      return json(c, 201, { ...fed, public_key: fedKeys.publicPem, pubkey_raw: pubPemToRaw(fedKeys.publicPem) })
    })),

    get("/me/federations/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const member = await localMemberFor(db, id, userId)
      if (!member) return json(c, 404, { error: "Federation not found" })
      const fed = await federationById(db, id)
      if (!fed) return json(c, 404, { error: "Federation not found" })
      return json(c, 200, {
        id: fed.id,
        slug: fed.slug,
        name: fed.name,
        description: fed.description,
        type: fed.type,
        public_key: fed.public_key,
        public_key_raw: pubPemToRaw(fed.public_key),
        replication_factor: fed.replication_factor,
        erasure_k: fed.erasure_k,
        erasure_m: fed.erasure_m,
        quota_multiplier: String(fed.quota_multiplier),
        is_admin: member.is_admin,
        contributed_bytes: Number(member.contributed_bytes),
        used_bytes: Number(member.used_bytes),
        status: member.status,
        created_at: fed.created_at,
      })
    })),

    del("/me/federations/:id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const member = await localMemberFor(db, id, userId)
      if (!member) return json(c, 404, { error: "Federation not found" })
      // For the MVP, "leave" marks the local member as draining. The actual
      // drain sweep (Phase 5) re-replicates shards off this instance before
      // hard-removing the membership.
      await db.execute(
        from("federation_members").where(q => q("id").equals(member.id)).update({ status: "draining" }),
      )
      logEvent(db, { userId, event: "federation.leaving", metadata: { federation_id: id } })
      return json(c, 202, { draining: id })
    })),

    get("/me/federations/:id/members", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const member = await localMemberFor(db, id, userId)
      if (!member) return json(c, 404, { error: "Federation not found" })
      const all = await membersForFederation(db, id)
      return json(c, 200, all.map(m => ({
        id: m.id,
        peer_pubkey: m.peer_pubkey,
        peer_base_url: m.peer_base_url,
        display_name: m.display_name,
        is_local: m.is_local,
        is_admin: m.is_admin,
        contributed_bytes: Number(m.contributed_bytes),
        used_bytes: Number(m.used_bytes),
        status: m.status,
        joined_at: m.joined_at,
        last_seen_at: m.last_seen_at,
      })))
    })),

    post("/me/federations/:id/invites", authed(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      if (!await isLocalAdmin(db, id, userId)) {
        return json(c, 403, { error: "Only federation admins can mint invites" })
      }
      const body = c.body as InviteBody
      const ttlHours = Number.isFinite(body.ttl_hours) ? Number(body.ttl_hours) : 168
      if (ttlHours < 1 || ttlHours > 24 * 30) return json(c, 422, { error: "ttl_hours must be 1-720" })

      const fed = await federationById(db, id)
      if (!fed) return json(c, 404, { error: "Federation not found" })

      const { token, expiresAt } = await mintInvite(db, fed, publicBaseUrl, ttlHours * 3600, userId)
      return json(c, 201, { token, expires_at: expiresAt.toISOString() })
    })),

    get("/me/federations/:id/invites", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      if (!await isLocalAdmin(db, id, userId)) {
        return json(c, 403, { error: "Only federation admins can list invites" })
      }
      const rows = await db.all(
        from("federation_invites")
          .where(q => q("federation_id").equals(id))
          .select("id", "expires_at", "used_at", "used_by_pubkey", "created_by", "created_at")
          .orderBy("created_at", "DESC")
          .limit(200),
      )
      return json(c, 200, rows)
    })),

    del("/me/federations/:id/invites/:invite_id", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const inviteId = Number(c.params.invite_id)
      if (!await isLocalAdmin(db, id, userId)) {
        return json(c, 403, { error: "Only federation admins can revoke invites" })
      }
      await db.execute(
        from("federation_invites").where(q => q("id").equals(inviteId)).where(q => q("federation_id").equals(id)).del(),
      )
      return json(c, 200, { revoked: inviteId })
    })),

    post("/me/federations/accept", authed(async (c) => {
      const userId = authId(c)
      const body = c.body as AcceptBody
      const tokenStr = (body.invite ?? "").trim()
      if (!tokenStr) return json(c, 422, { error: "invite required" })

      const parsed = parseInvite(tokenStr)
      if ("error" in parsed) return json(c, 422, { error: parsed.error })

      // If we've already paired with this federation, refuse the duplicate.
      const existing = await federationBySlug(db, parsed.body.slug)
      if (existing) {
        const m = await localMemberFor(db, existing.id, userId)
        if (m) return json(c, 409, { error: "Already a member of this federation" })
      }

      const instanceKeys = await getInstanceKeys(db)

      // Reach out to the introducer. They verify the invite + sign us up.
      let pairResponse
      try {
        pairResponse = await callPair(
          parsed.body.introducer,
          tokenStr,
          instanceKeys.ed25519PublicRaw,
          instanceKeys.x25519PublicRaw,
          publicBaseUrl,
          body.display_name?.trim() || null,
        )
      } catch (err) {
        return json(c, 502, { error: "Pairing handshake failed", detail: (err as Error).message })
      }

      // Persist the federation locally. If we already had a stub row from a
      // prior failed accept, update it; otherwise insert.
      let fedId: number
      if (existing) {
        fedId = existing.id
      } else {
        const inserted = await db.execute(
          from("federations").insert({
            slug: pairResponse.federation.slug,
            name: pairResponse.federation.name,
            description: pairResponse.federation.description,
            type: pairResponse.federation.type,
            public_key: pairResponse.federation.public_key,
            private_key: null,
            replication_factor: pairResponse.federation.replication_factor,
            erasure_k: pairResponse.federation.erasure_k,
            erasure_m: pairResponse.federation.erasure_m,
            quota_multiplier: String(pairResponse.federation.quota_multiplier),
            group_key_encrypted: pairResponse.group_key_sealed,
            created_by: userId,
          }).returning("id"),
        ) as Array<{ id: number }>
        fedId = inserted[0]!.id
      }

      // Local membership row (us).
      await db.execute(
        from("federation_members").insert({
          federation_id: fedId,
          user_id: userId,
          peer_pubkey: instanceKeys.ed25519PublicRaw,
          peer_x25519_pubkey: instanceKeys.x25519PublicRaw,
          peer_base_url: publicBaseUrl,
          display_name: body.display_name?.trim() || null,
          is_local: true,
          is_admin: false,
          contributed_bytes: 0,
          used_bytes: 0,
          status: "active",
        }),
      )

      // The introducer (remote) — separate row so we can fetch from them.
      await db.execute({
        text: `INSERT INTO federation_members
                 (federation_id, user_id, peer_pubkey, peer_x25519_pubkey, peer_base_url, display_name, is_local, is_admin, status)
               VALUES ($1, NULL, $2, $3, $4, $5, FALSE, TRUE, 'active')
               ON CONFLICT (federation_id, peer_pubkey, COALESCE(user_id, 0))
               DO UPDATE SET peer_base_url = EXCLUDED.peer_base_url,
                             peer_x25519_pubkey = EXCLUDED.peer_x25519_pubkey,
                             status = 'active'`,
        values: [
          fedId,
          pairResponse.introducer.peer_pubkey,
          pairResponse.introducer.peer_x25519_pubkey,
          pairResponse.introducer.peer_base_url,
          "introducer",
        ],
      })

      // Other members the introducer told us about. Best-effort, don't
      // fail the accept if any individual insert hits a constraint.
      for (const m of pairResponse.members) {
        try {
          await db.execute({
            text: `INSERT INTO federation_members
                     (federation_id, peer_pubkey, peer_x25519_pubkey, peer_base_url, display_name, is_local, is_admin, status)
                   VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, 'active')
                   ON CONFLICT (federation_id, peer_pubkey, COALESCE(user_id, 0)) DO NOTHING`,
            values: [fedId, m.peer_pubkey, m.peer_x25519_pubkey, m.peer_base_url, m.display_name],
          })
        } catch {
          // Tolerate gossip inconsistencies. Members refresh on next contact.
        }
      }

      logEvent(db, { userId, event: "federation.joined", metadata: { federation_id: fedId, slug: pairResponse.federation.slug } })
      return json(c, 201, { id: fedId, slug: pairResponse.federation.slug, type: pairResponse.federation.type })
    })),

    // Introspection helper for users to confirm this instance's pubkey
    // before founding a federation or accepting an invite. Useful for
    // displaying "this server's fingerprint" in the UI.
    get("/me/federations/instance/keys", guard(async (c) => {
      const k = await getInstanceKeys(db)
      return json(c, 200, {
        ed25519_pubkey: k.ed25519PublicRaw,
        x25519_pubkey: k.x25519PublicRaw,
      })
    })),

    // Federation health snapshot: counts and replication metrics. Available
    // to all members so they can see whether their federation is healthy;
    // does NOT expose private member data.
    get("/me/federations/:id/health", guard(async (c) => {
      const userId = authId(c)
      const id = Number(c.params.id)
      const member = await localMemberFor(db, id, userId)
      if (!member) return json(c, 404, { error: "Federation not found" })

      const memberStats = await db.execute({
        text: `SELECT status, COUNT(*)::int AS n, SUM(contributed_bytes)::bigint AS contributed, SUM(used_bytes)::bigint AS used
                 FROM federation_members WHERE federation_id = $1 GROUP BY status`,
        values: [id],
      }) as Array<{ status: string; n: number; contributed: string | number; used: string | number }>

      const blobCount = await db.one({
        text: `SELECT COUNT(DISTINCT blob_id)::int AS n FROM federation_blobs WHERE federation_id = $1`,
        values: [id],
      }) as { n: number } | null

      const shardCount = await db.one({
        text: `SELECT COUNT(DISTINCT blob_id)::int AS n FROM federation_shards WHERE federation_id = $1`,
        values: [id],
      }) as { n: number } | null

      const underReplicated = await db.execute({
        text: `SELECT blob_id, COUNT(*)::int AS placements
                 FROM federation_blobs WHERE federation_id = $1
                 GROUP BY blob_id HAVING COUNT(*) < (SELECT replication_factor FROM federations WHERE id = $1)
                 LIMIT 50`,
        values: [id],
      }) as Array<{ blob_id: string; placements: number }>

      return json(c, 200, {
        federation_id: id,
        member_stats: memberStats.map(r => ({
          status: r.status,
          count: r.n,
          contributed_bytes: Number(r.contributed),
          used_bytes: Number(r.used),
        })),
        content_blobs: blobCount?.n ?? 0,
        space_blobs: shardCount?.n ?? 0,
        under_replicated: underReplicated,
      })
    })),
  ]
}

// Re-export utility helpers for other modules.
export { generateEd25519, randomToken }
