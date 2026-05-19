import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto"
import { ecdhX25519, generateX25519, rawX25519ToPem } from "./keys.ts"

// Symmetric crypto for federation:
//  - Group keys (content-sharing) and per-file keys (space-offering) are
//    AES-256-GCM.
//  - Sealed-box delivery wraps a symmetric key by deriving a shared secret
//    via X25519 ECDH and using HKDF-SHA256 to produce the wrap key.

export const generateSymmetricKey = (): Buffer => randomBytes(32)

export const aesGcmEncrypt = (key: Buffer, plaintext: Uint8Array | string): { ciphertext: string; iv: string; tag: string } => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const bytes = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext
  const enc = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()])
  return {
    ciphertext: enc.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  }
}

export const aesGcmDecrypt = (key: Buffer, ciphertextB64: string, ivB64: string, tagB64: string): Buffer => {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"))
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"))
  const enc = Buffer.from(ciphertextB64, "base64url")
  return Buffer.concat([decipher.update(enc), decipher.final()])
}

// HKDF-SHA256: extract + expand. salt may be empty; info disambiguates the
// derived key from other derivations using the same secret.
const hkdf = (ikm: Buffer, salt: Buffer, info: string, length: number = 32): Buffer => {
  const prk = createHmac("sha256", salt.length === 0 ? Buffer.alloc(32) : salt).update(ikm).digest()
  // Single-block expand is enough for length ≤ 32, which is the only call
  // path we use. Hardcoding T=1 keeps this trivial to audit.
  if (length > 32) throw new Error("hkdf single-block: length must be ≤ 32")
  const t1 = createHmac("sha256", prk).update(Buffer.from(info, "utf-8")).update(Buffer.from([0x01])).digest()
  return t1.subarray(0, length)
}

// Wrap a symmetric `key` so only the holder of theirX25519 private can open
// it. Returns a compact JSON-serializable string. Layout:
//   { e: <ephemeral X25519 pub raw b64url>, c: <ciphertext>, i: <iv>, t: <tag> }
// The wrap key is HKDF(ECDH(ephemeral, theirPub), salt = ephemeralPub).
export const sealForX25519 = (theirX25519PublicRaw: string, key: Buffer): string => {
  // Ephemeral X25519 keypair — fresh per seal to give forward secrecy.
  const eph = generateX25519()
  const shared = ecdhX25519(eph.privatePem, rawX25519ToPem(theirX25519PublicRaw))
  const wrapKey = hkdf(shared, Buffer.from(eph.publicRaw, "base64url"), "stohr-federation-seal-v1")
  const sealed = aesGcmEncrypt(wrapKey, key)
  return JSON.stringify({ e: eph.publicRaw, c: sealed.ciphertext, i: sealed.iv, t: sealed.tag })
}

export const openSealedX25519 = (ourX25519PrivatePem: string, sealed: string): Buffer => {
  const parsed = JSON.parse(sealed) as { e: string; c: string; i: string; t: string }
  const shared = ecdhX25519(ourX25519PrivatePem, rawX25519ToPem(parsed.e))
  const wrapKey = hkdf(shared, Buffer.from(parsed.e, "base64url"), "stohr-federation-seal-v1")
  return aesGcmDecrypt(wrapKey, parsed.c, parsed.i, parsed.t)
}

export const sha256Hex = (input: Uint8Array | string): string => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex")
}

export const sha256Bytes = (input: Uint8Array | string): Buffer => {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  return createHash("sha256").update(Buffer.from(bytes)).digest()
}
