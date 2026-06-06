import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { halt } from "@atlas/server"
import { sha256Hex } from "./crypto.ts"
import { getInstanceKeys, rawEd25519ToPem, signEd25519, verifyEd25519 } from "./keys.ts"

// Peer-to-peer transport is HTTPS with signed headers. Every outbound
// request carries:
//   x-fed-pubkey:   sender's Ed25519 pubkey (raw base64url)
//   x-fed-ts:       unix timestamp seconds
//   x-fed-nonce:    24 bytes base64url, random per request
//   x-fed-body-sha: sha256 of body bytes (hex), or "-" when no body
//   x-fed-sig:      Ed25519 sig over the canonical signing string
//
// Signing string:
//   <method> + "\n" + <path-with-query> + "\n" + <ts> + "\n" + <nonce> + "\n" + <body-sha>
//
// Receivers verify the signature against the claimed pubkey, then look up
// the membership row for that pubkey in the federation referenced by the
// request. Replay protection: reject ts skewed more than 5 minutes.

const SIG_SKEW_SECONDS = 300

export type SignedRequestParts = {
  method: string
  url: string
  body?: Uint8Array | string
}

export const buildSigningString = (
  method: string,
  pathWithQuery: string,
  ts: number,
  nonce: string,
  bodySha: string,
): string => `${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${nonce}\n${bodySha}`

const bodyBytes = (body?: Uint8Array | string): Uint8Array => {
  if (body == null) return new Uint8Array()
  if (typeof body === "string") return new TextEncoder().encode(body)
  return body
}

export const peerFetch = async (
  db: Connection,
  baseUrl: string,
  pathWithQuery: string,
  init: { method?: string; body?: Uint8Array | string; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response> => {
  const keys = await getInstanceKeys(db)
  const method = (init.method ?? "GET").toUpperCase()
  const ts = Math.floor(Date.now() / 1000)
  const nonce = crypto.randomUUID().replace(/-/g, "")
  const bodyBuf = bodyBytes(init.body)
  const bodySha = bodyBuf.length === 0 ? "-" : sha256Hex(bodyBuf)
  const signingString = buildSigningString(method, pathWithQuery, ts, nonce, bodySha)
  const sig = signEd25519(keys.ed25519PrivatePem, signingString)

  const headers: Record<string, string> = {
    ...(init.headers ?? {}),
    "x-fed-pubkey": keys.ed25519PublicRaw,
    "x-fed-ts": String(ts),
    "x-fed-nonce": nonce,
    "x-fed-body-sha": bodySha,
    "x-fed-sig": sig,
  }

  const trimmedBase = baseUrl.replace(/\/+$/, "")
  // BodyInit accepts ArrayBuffer / Buffer / Blob — Uint8Array's exact typing
  // confuses tsc, so coerce via the underlying ArrayBuffer slice.
  const reqBody =
    bodyBuf.length > 0
      ? (bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.byteLength) as ArrayBuffer)
      : undefined
  return await fetch(`${trimmedBase}${pathWithQuery}`, {
    method,
    headers,
    body: reqBody,
    signal: init.signal,
  })
}

export type VerifiedPeer = {
  pubkeyRaw: string
  pubkeyPem: string
  member: { id: number; federation_id: number; user_id: number | null; peer_base_url: string } | null
}

// Verifies the peer signature on an inbound request. Does NOT confirm the
// peer is a member of a specific federation — that's the caller's job once
// it knows which federation_id the request is targeting.
export const verifyInboundSignature = async (
  conn: Conn,
  body: Uint8Array,
): Promise<{ ok: true; pubkeyRaw: string; pubkeyPem: string } | { ok: false; error: string }> => {
  const pubkeyRaw = conn.headers.get("x-fed-pubkey")
  const tsHeader = conn.headers.get("x-fed-ts")
  const nonce = conn.headers.get("x-fed-nonce")
  const bodyShaClaim = conn.headers.get("x-fed-body-sha")
  const sig = conn.headers.get("x-fed-sig")
  if (!pubkeyRaw || !tsHeader || !nonce || !bodyShaClaim || !sig) {
    return { ok: false, error: "Missing peer signature headers" }
  }
  const ts = Number(tsHeader)
  if (!Number.isFinite(ts)) return { ok: false, error: "Invalid x-fed-ts" }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > SIG_SKEW_SECONDS) {
    return { ok: false, error: "Peer signature timestamp out of skew" }
  }
  const bodyShaActual = body.length === 0 ? "-" : sha256Hex(body)
  if (bodyShaClaim !== bodyShaActual) {
    return { ok: false, error: "Body hash mismatch" }
  }
  const url = new URL(conn.request.url)
  const pathWithQuery = url.pathname + url.search
  const signingString = buildSigningString(conn.request.method, pathWithQuery, ts, nonce, bodyShaClaim)
  let pubkeyPem: string
  try {
    pubkeyPem = rawEd25519ToPem(pubkeyRaw)
  } catch {
    return { ok: false, error: "Invalid peer pubkey encoding" }
  }
  if (!verifyEd25519(pubkeyPem, signingString, sig)) {
    return { ok: false, error: "Peer signature verification failed" }
  }
  return { ok: true, pubkeyRaw, pubkeyPem }
}

// Pipeline helper for receiver routes — verifies signature and stashes
// pubkey + raw body in c.assigns. Most receiver routes also want to verify
// federation membership, which is delegated to the route handler.
export const requirePeerSignature =
  () =>
  async (conn: Conn): Promise<Conn> => {
    const buf = new Uint8Array(await conn.request.clone().arrayBuffer())
    const v = await verifyInboundSignature(conn, buf)
    if (!v.ok) return halt(conn, 401, { error: v.error })
    return {
      ...conn,
      assigns: { ...conn.assigns, peer: { pubkeyRaw: v.pubkeyRaw, pubkeyPem: v.pubkeyPem, body: buf } },
    }
  }

export const memberForPeer = async (
  db: Connection,
  federationId: number,
  pubkeyRaw: string,
): Promise<{
  id: number
  federation_id: number
  user_id: number | null
  peer_base_url: string
  status: string
  is_admin: boolean
} | null> => {
  return (await db.one(
    from("federation_members")
      .where(q => q("federation_id").equals(federationId))
      .where(q => q("peer_pubkey").equals(pubkeyRaw))
      .where(q => q("is_local").equals(false))
      .select("id", "federation_id", "user_id", "peer_base_url", "status", "is_admin"),
  )) as {
    id: number
    federation_id: number
    user_id: number | null
    peer_base_url: string
    status: string
    is_admin: boolean
  } | null
}
