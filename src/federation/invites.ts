import { createHash } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { pubPemToRaw, randomToken, signEd25519, verifyEd25519Raw } from "./keys.ts"

// Invite tokens are signed JWS-like payloads. The wire format is
// "<header>.<body>.<sig>", base64url-encoded, where:
//   header = { v: 1, alg: "Ed25519", kid: <federation pubkey raw> }
//   body   = { fed_id, slug, name, type, introducer, exp, nonce }
// Signed by the federation private key. The accepting instance verifies the
// signature against the embedded `kid` (trust-on-first-use); a hash of the
// nonce is also persisted server-side as token_hash so the introducer can
// revoke + enforce single-use even before the recipient redeems.

export type InviteHeader = {
  v: 1
  alg: "Ed25519"
  kid: string
}

export type InviteBody = {
  fed_id: number
  slug: string
  name: string
  type: "content-sharing" | "space-offering"
  introducer: string
  exp: number
  nonce: string
}

const b64urlEncode = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString("base64url")

const b64urlDecode = <T>(s: string): T => JSON.parse(Buffer.from(s, "base64url").toString("utf-8")) as T

const hashNonce = (nonce: string): string =>
  createHash("sha256").update(nonce).digest("hex")

type FederationRow = {
  id: number
  slug: string
  name: string
  type: string
  public_key: string
  private_key: string | null
}

export const mintInvite = async (
  db: Connection,
  fed: FederationRow,
  introducerBaseUrl: string,
  ttlSeconds: number,
  createdBy: number | null,
): Promise<{ token: string; expiresAt: Date }> => {
  if (!fed.private_key) {
    throw new Error("Cannot mint invites for a federation we don't admin")
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const nonce = randomToken(24)
  const fedPubRaw = pubPemToRaw(fed.public_key)

  const header: InviteHeader = { v: 1, alg: "Ed25519", kid: fedPubRaw }
  const body: InviteBody = {
    fed_id: fed.id,
    slug: fed.slug,
    name: fed.name,
    type: fed.type as InviteBody["type"],
    introducer: introducerBaseUrl,
    exp,
    nonce,
  }
  const headerB64 = b64urlEncode(header)
  const bodyB64 = b64urlEncode(body)
  const signingInput = `${headerB64}.${bodyB64}`
  const signature = signEd25519(fed.private_key, signingInput)
  const token = `${signingInput}.${signature}`

  await db.execute(
    from("federation_invites").insert({
      federation_id: fed.id,
      token_hash: hashNonce(nonce),
      expires_at: new Date(exp * 1000),
      created_by: createdBy,
    }),
  )
  return { token, expiresAt: new Date(exp * 1000) }
}

export type ParsedInvite = {
  header: InviteHeader
  body: InviteBody
  raw: string
}

export const parseInvite = (token: string): ParsedInvite | { error: string } => {
  const parts = token.split(".")
  if (parts.length !== 3) return { error: "Malformed invite token" }
  const [headerB64, bodyB64, sig] = parts
  let header: InviteHeader
  let body: InviteBody
  try {
    header = b64urlDecode<InviteHeader>(headerB64!)
    body = b64urlDecode<InviteBody>(bodyB64!)
  } catch {
    return { error: "Invite token is not valid base64url JSON" }
  }
  if (header.v !== 1 || header.alg !== "Ed25519") {
    return { error: "Unsupported invite version or algorithm" }
  }
  if (!verifyEd25519Raw(header.kid, `${headerB64}.${bodyB64}`, sig!)) {
    return { error: "Invite signature failed verification" }
  }
  if (body.exp < Math.floor(Date.now() / 1000)) {
    return { error: "Invite token expired" }
  }
  return { header, body, raw: token }
}

// Marks the matching invite row used. Returns false if the invite was
// already redeemed or no longer exists (the caller should refuse to pair).
export const markInviteUsed = async (
  db: Connection,
  federationId: number,
  nonce: string,
  usedByPubkeyRaw: string,
): Promise<boolean> => {
  const tokenHash = hashNonce(nonce)
  const updated = await db.execute({
    text: `UPDATE federation_invites
              SET used_at = NOW(), used_by_pubkey = $1
            WHERE federation_id = $2
              AND token_hash = $3
              AND used_at IS NULL
              AND expires_at > NOW()
            RETURNING id`,
    values: [usedByPubkeyRaw, federationId, tokenHash],
  }) as Array<{ id: number }>
  return updated.length > 0
}

// Periodic sweep: expired-and-unused invites. Used invites stay around so
// admins can audit "who joined with which token."
export const sweepExpiredFederationInvites = async (db: Connection): Promise<void> => {
  await db.execute(
    from("federation_invites")
      .where(q => q("used_at").isNull())
      .where(q => q("expires_at").lessThan(raw("NOW()")))
      .del(),
  )
}
