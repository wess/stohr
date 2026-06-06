import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { json, parseJson, pipeline, post } from "@atlas/server"
import { requireSettingEnabled, SETTING_FEDERATION_ENABLED } from "../settings/index.ts"
import { aesGcmDecrypt, openSealedX25519, sealForX25519 } from "./crypto.ts"
import { markInviteUsed, mintInvite, parseInvite } from "./invites.ts"
import { getInstanceKeys } from "./keys.ts"
import { federationById, federationBySlug, fedPublicKeyRaw, remoteMembersForFederation } from "./membership.ts"
import { peerFetch } from "./transport.ts"

// Body of the inbound /federation/pair request from a joining instance.
type PairRequest = {
  invite: string
  peer_pubkey: string
  peer_x25519_pubkey: string
  peer_base_url: string
  display_name?: string
}

// Body returned to the joiner.
type PairResponse = {
  federation: {
    id: number
    slug: string
    name: string
    description: string | null
    type: "content-sharing" | "space-offering"
    public_key: string
    replication_factor: number
    erasure_k: number | null
    erasure_m: number | null
    quota_multiplier: string
  }
  group_key_sealed: string | null
  introducer: {
    peer_pubkey: string
    peer_x25519_pubkey: string
    peer_base_url: string
  }
  members: Array<{
    peer_pubkey: string
    peer_x25519_pubkey: string | null
    peer_base_url: string
    user_id: number | null
    display_name: string | null
  }>
}

// Receiver endpoint mounted on every instance. The joiner posts the invite
// they got out-of-band; the introducer verifies it, persists the new member,
// and replies with what the joiner needs to begin operating.
//
// This route deliberately does NOT use the standard peer signature transport
// — at pair time the joining instance is not yet a known peer. The invite
// signature (Ed25519 by federation key, verified inline) is the only thing
// authenticating the request.
export const pairingReceiverRoutes = (db: Connection, publicBaseUrl: string) => {
  const open = pipeline(requireSettingEnabled(db, SETTING_FEDERATION_ENABLED), parseJson)

  return [
    post(
      "/federation/pair",
      open(async c => {
        const body = c.body as PairRequest
        if (!body?.invite || !body.peer_pubkey || !body.peer_x25519_pubkey || !body.peer_base_url) {
          return json(c, 422, { error: "invite, peer_pubkey, peer_x25519_pubkey, peer_base_url required" })
        }

        const parsed = parseInvite(body.invite)
        if ("error" in parsed) return json(c, 422, { error: parsed.error })

        const fed = await federationById(db, parsed.body.fed_id)
        if (!fed) return json(c, 404, { error: "Federation not found on this introducer" })
        if (!fed.private_key) return json(c, 403, { error: "This instance is not an admin of the federation" })

        const fedPubRaw = fedPublicKeyRaw(fed)
        if (fedPubRaw !== parsed.header.kid) {
          return json(c, 422, { error: "Invite federation key mismatch" })
        }

        const claimed = await markInviteUsed(db, fed.id, parsed.body.nonce, body.peer_pubkey)
        if (!claimed) {
          return json(c, 409, { error: "Invite already used or expired" })
        }

        // Persist the joining peer as a remote member of this federation. If
        // the same peer is rejoining (e.g. previous departure), update their
        // base URL + x25519 pubkey rather than failing the unique index.
        const existing = (await db.one(
          from("federation_members")
            .where(q => q("federation_id").equals(fed.id))
            .where(q => q("peer_pubkey").equals(body.peer_pubkey))
            .where(q => q("is_local").equals(false))
            .select("id"),
        )) as { id: number } | null

        if (existing) {
          await db.execute(
            from("federation_members")
              .where(q => q("id").equals(existing.id))
              .update({
                peer_x25519_pubkey: body.peer_x25519_pubkey,
                peer_base_url: body.peer_base_url,
                display_name: body.display_name ?? null,
                status: "active",
              }),
          )
        } else {
          await db.execute(
            from("federation_members").insert({
              federation_id: fed.id,
              user_id: null,
              peer_pubkey: body.peer_pubkey,
              peer_x25519_pubkey: body.peer_x25519_pubkey,
              peer_base_url: body.peer_base_url,
              display_name: body.display_name ?? null,
              is_local: false,
              is_admin: false,
              contributed_bytes: 0,
              used_bytes: 0,
              status: "active",
            }),
          )
        }

        let groupKeySealed: string | null = null
        if (fed.type === "content-sharing" && fed.group_key_encrypted) {
          // Unwrap the group key (it's stored sealed-to-our-own-x25519-pubkey)
          // and reseal to the joining peer's x25519 pubkey. The plaintext key
          // never leaves the introducer in memory beyond this scope.
          const keys = await getInstanceKeys(db)
          const groupKey = openSealedX25519(keys.x25519PrivatePem, fed.group_key_encrypted)
          groupKeySealed = sealForX25519(body.peer_x25519_pubkey, groupKey)
          groupKey.fill(0)
        }

        const others = await remoteMembersForFederation(db, fed.id)
        const introducerKeys = await getInstanceKeys(db)

        const response: PairResponse = {
          federation: {
            id: fed.id,
            slug: fed.slug,
            name: fed.name,
            description: fed.description,
            type: fed.type,
            public_key: fed.public_key,
            replication_factor: fed.replication_factor,
            erasure_k: fed.erasure_k,
            erasure_m: fed.erasure_m,
            quota_multiplier: String(fed.quota_multiplier),
          },
          group_key_sealed: groupKeySealed,
          introducer: {
            peer_pubkey: introducerKeys.ed25519PublicRaw,
            peer_x25519_pubkey: introducerKeys.x25519PublicRaw,
            peer_base_url: publicBaseUrl,
          },
          members: others
            .filter(m => m.peer_pubkey !== body.peer_pubkey)
            .map(m => ({
              peer_pubkey: m.peer_pubkey,
              peer_x25519_pubkey: m.peer_x25519_pubkey,
              peer_base_url: m.peer_base_url,
              user_id: m.user_id,
              display_name: m.display_name,
            })),
        }

        return json(c, 200, response)
      }),
    ),
  ]
}

// Client-side: this instance accepting an invite token. Returns the pairing
// response so the route handler can write the joining member's local row.
export const callPair = async (
  introducerBaseUrl: string,
  invite: string,
  peerPubkey: string,
  peerX25519Pubkey: string,
  peerBaseUrl: string,
  displayName: string | null,
): Promise<PairResponse> => {
  const trimmed = introducerBaseUrl.replace(/\/+$/, "")
  const body: PairRequest = {
    invite,
    peer_pubkey: peerPubkey,
    peer_x25519_pubkey: peerX25519Pubkey,
    peer_base_url: peerBaseUrl,
    display_name: displayName ?? undefined,
  }
  const res = await fetch(`${trimmed}/federation/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Pairing failed (${res.status}): ${errBody}`)
  }
  return (await res.json()) as PairResponse
}

export { aesGcmDecrypt, federationBySlug, mintInvite, parseInvite, peerFetch }
