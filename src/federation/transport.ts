import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import type { Conn } from "@atlas/server"
import { halt } from "@atlas/server"
import { safeFetch } from "../util/safeurl/index.ts"
import { sha256Hex } from "./crypto.ts"
import { getInstanceKeys, rawEd25519ToPem, signEd25519, verifyEd25519 } from "./keys.ts"
import { peerUrlOpts } from "./urls.ts"

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
// Receivers verify the signature against the claimed pubkey, check that
// pubkey belongs to some active peer, and only then read the body. Replay
// protection: reject ts skewed more than 5 minutes, and remember every
// (pubkey, nonce) pair for that window so a captured request can't be
// resent.

const SIG_SKEW_SECONDS = 300
const NONCE_TTL_SECONDS = SIG_SKEW_SECONDS * 2
const MAX_NONCE_CHARS = 128
export const DEFAULT_PEER_BODY_LIMIT = 1024 * 1024 * 1024

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
  // peer_base_url came from a peer at pair time; it gets the same scrutiny
  // on every use in case the row predates the check or was gossiped
  return await safeFetch(
    `${trimmedBase}${pathWithQuery}`,
    { method, headers, body: reqBody, signal: init.signal },
    peerUrlOpts(),
  )
}

export type VerifiedPeer = {
  pubkeyRaw: string
  pubkeyPem: string
  member: { id: number; federation_id: number; user_id: number | null; peer_base_url: string } | null
}

type PeerHeaders =
  | { ok: true; pubkeyRaw: string; pubkeyPem: string; nonce: string; bodySha: string }
  | { ok: false; error: string }

// Everything that can be checked without the body: header presence, clock
// skew, pubkey encoding, and the signature itself. The signature covers the
// claimed body hash, so a forged request is rejected before a single byte
// of body is buffered.
export const verifyPeerHeaders = (conn: Conn): PeerHeaders => {
  const pubkeyRaw = conn.headers.get("x-fed-pubkey")
  const tsHeader = conn.headers.get("x-fed-ts")
  const nonce = conn.headers.get("x-fed-nonce")
  const bodySha = conn.headers.get("x-fed-body-sha")
  const sig = conn.headers.get("x-fed-sig")
  if (!pubkeyRaw || !tsHeader || !nonce || !bodySha || !sig) {
    return { ok: false, error: "Missing peer signature headers" }
  }
  if (nonce.length > MAX_NONCE_CHARS) return { ok: false, error: "Invalid x-fed-nonce" }
  const ts = Number(tsHeader)
  if (!Number.isFinite(ts)) return { ok: false, error: "Invalid x-fed-ts" }
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - ts) > SIG_SKEW_SECONDS) {
    return { ok: false, error: "Peer signature timestamp out of skew" }
  }
  const url = new URL(conn.request.url)
  const signingString = buildSigningString(conn.request.method, url.pathname + url.search, ts, nonce, bodySha)
  let pubkeyPem: string
  try {
    pubkeyPem = rawEd25519ToPem(pubkeyRaw)
  } catch {
    return { ok: false, error: "Invalid peer pubkey encoding" }
  }
  if (!verifyEd25519(pubkeyPem, signingString, sig)) {
    return { ok: false, error: "Peer signature verification failed" }
  }
  return { ok: true, pubkeyRaw, pubkeyPem, nonce, bodySha }
}

// "Is this pubkey an active remote member of anything?" — the per-federation
// check still happens in the handler once it knows the slug.
const knownPeer = async (db: Connection, pubkeyRaw: string): Promise<boolean> => {
  const row = await db.one(
    from("federation_members")
      .where(q => q("peer_pubkey").equals(pubkeyRaw))
      .where(q => q("is_local").equals(false))
      .where(q => q("status").equals("active"))
      .select("id")
      .limit(1),
  )
  return !!row
}

// First sight of a (pubkey, nonce) pair wins; a second sight is a replay.
const claimNonce = async (db: Connection, pubkeyRaw: string, nonce: string): Promise<boolean> => {
  const rows = (await db.execute({
    text: `INSERT INTO federation_nonces (peer_pubkey, nonce) VALUES ($1, $2)
           ON CONFLICT DO NOTHING RETURNING nonce`,
    values: [pubkeyRaw, nonce],
  })) as Array<{ nonce: string }>
  return rows.length > 0
}

const readCapped = async (body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> => {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let seen = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    seen += value.byteLength
    if (seen > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(seen)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

// Pipeline helper for receiver routes. Order matters: signature, then
// membership, then the content-length cap and nonce claim, and only then
// the body read + hash compare. Stashes pubkey + raw body in c.assigns.peer.
export const requirePeerSignature =
  (db: Connection, opts: { maxBodyBytes?: number } = {}) =>
  async (conn: Conn): Promise<Conn> => {
    const v = verifyPeerHeaders(conn)
    if (!v.ok) return halt(conn, 401, { error: v.error })
    if (!(await knownPeer(db, v.pubkeyRaw))) return halt(conn, 403, { error: "Unknown federation peer" })

    const max = opts.maxBodyBytes ?? DEFAULT_PEER_BODY_LIMIT
    const declared = conn.headers.get("content-length")
    if (declared !== null && Number(declared) > max) return halt(conn, 413, { error: "Peer body too large" })

    if (!(await claimNonce(db, v.pubkeyRaw, v.nonce))) return halt(conn, 401, { error: "Replayed peer nonce" })

    const buf = await readCapped(conn.request.body, max)
    if (!buf) return halt(conn, 413, { error: "Peer body too large" })
    const actual = buf.length === 0 ? "-" : sha256Hex(buf)
    if (actual !== v.bodySha) return halt(conn, 401, { error: "Body hash mismatch" })

    return {
      ...conn,
      assigns: { ...conn.assigns, peer: { pubkeyRaw: v.pubkeyRaw, pubkeyPem: v.pubkeyPem, body: buf } },
    }
  }

// Periodic sweep: nonces older than the skew window can't be replayed anyway
// because the timestamp check refuses them.
export const sweepFederationNonces = async (db: Connection): Promise<void> => {
  await db.execute({
    text: `DELETE FROM federation_nonces WHERE seen_at < NOW() - ($1 || ' seconds')::interval`,
    values: [String(NONCE_TTL_SECONDS)],
  })
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
