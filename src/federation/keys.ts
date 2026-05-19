import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"

// Two keypairs live per instance: Ed25519 signs peer-to-peer requests and
// invite tokens; X25519 is used for ECDH so the introducer can encrypt the
// federation group key to a joining peer's pubkey. Storage format is PEM,
// because that round-trips cleanly through Node's crypto KeyObject without
// custom DER parsing.

export type InstanceKeys = {
  ed25519PublicPem: string
  ed25519PrivatePem: string
  ed25519PublicRaw: string
  x25519PublicPem: string
  x25519PrivatePem: string
  x25519PublicRaw: string
}

const pemToRawPub = (pem: string): string => {
  const jwk = createPublicKey(pem).export({ format: "jwk" }) as { x: string }
  return jwk.x
}

const rawToPemPubEd25519 = (raw: string): string => {
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw }, format: "jwk" })
  return key.export({ type: "spki", format: "pem" }) as string
}

const rawToPemPubX25519 = (raw: string): string => {
  const key = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw }, format: "jwk" })
  return key.export({ type: "spki", format: "pem" }) as string
}

export const generateEd25519 = (): { publicPem: string; privatePem: string; publicRaw: string } => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string
  return { publicPem, privatePem, publicRaw: pemToRawPub(publicPem) }
}

export const generateX25519 = (): { publicPem: string; privatePem: string; publicRaw: string } => {
  const { publicKey, privateKey } = generateKeyPairSync("x25519")
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string
  return { publicPem, privatePem, publicRaw: pemToRawPub(publicPem) }
}

type InstanceKeyRow = {
  public_key: string
  private_key: string
  x25519_public_key: string
  x25519_private_key: string
}

// Lazy bootstrap: first caller generates and inserts the singleton row. The
// ON CONFLICT clause makes concurrent first-callers idempotent — only one
// row ever exists.
export const getInstanceKeys = async (db: Connection): Promise<InstanceKeys> => {
  const existing = await db.one(
    from("instance_keys").where(q => q("id").equals(1)).select("public_key", "private_key", "x25519_public_key", "x25519_private_key"),
  ) as InstanceKeyRow | null
  if (existing) {
    return {
      ed25519PublicPem: existing.public_key,
      ed25519PrivatePem: existing.private_key,
      ed25519PublicRaw: pemToRawPub(existing.public_key),
      x25519PublicPem: existing.x25519_public_key,
      x25519PrivatePem: existing.x25519_private_key,
      x25519PublicRaw: pemToRawPub(existing.x25519_public_key),
    }
  }
  const ed = generateEd25519()
  const xk = generateX25519()
  await db.execute({
    text: `INSERT INTO instance_keys (id, public_key, private_key, x25519_public_key, x25519_private_key)
           VALUES (1, $1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING`,
    values: [ed.publicPem, ed.privatePem, xk.publicPem, xk.privatePem],
  })
  // Re-fetch in case a concurrent caller won the insert race.
  return getInstanceKeys(db)
}

export const signEd25519 = (privatePem: string, message: Uint8Array | string): string => {
  const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message
  const sig = cryptoSign(null, Buffer.from(bytes), createPrivateKey(privatePem))
  return sig.toString("base64url")
}

export const verifyEd25519 = (publicPem: string, message: Uint8Array | string, signatureBase64Url: string): boolean => {
  try {
    const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message
    return cryptoVerify(null, Buffer.from(bytes), createPublicKey(publicPem), Buffer.from(signatureBase64Url, "base64url"))
  } catch {
    return false
  }
}

// X25519 ECDH — shared secret between our private and a peer's public.
export const ecdhX25519 = (ourPrivatePem: string, theirPublicPem: string): Buffer => {
  return diffieHellman({
    privateKey: createPrivateKey(ourPrivatePem),
    publicKey: createPublicKey(theirPublicPem),
  })
}

// Helpers that take raw base64url pubkeys (the form used over the wire and
// for compact display) and reconstruct the PEM internally. Useful for
// verifying signatures from peers identified only by their compact pubkey.
export const verifyEd25519Raw = (publicRaw: string, message: Uint8Array | string, signatureBase64Url: string): boolean => {
  try {
    return verifyEd25519(rawToPemPubEd25519(publicRaw), message, signatureBase64Url)
  } catch {
    return false
  }
}

export const rawX25519ToPem = (raw: string): string => rawToPemPubX25519(raw)
export const rawEd25519ToPem = (raw: string): string => rawToPemPubEd25519(raw)
export const pubPemToRaw = (pem: string): string => pemToRawPub(pem)

export const fingerprintPubkey = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex").slice(0, 16)

export const randomToken = (bytes: number = 32): string => randomBytes(bytes).toString("base64url")
