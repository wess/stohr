import { createHash } from "node:crypto"

export const randomToken = (bytes = 24) => {
  const buf = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("")
}

// SHA-256 hex digest. Used to store opaque tokens (invites, password resets,
// PATs) at rest while still being able to look them up in O(1).
export const sha256Hex = (input: string): string =>
  createHash("sha256").update(input).digest("hex")
