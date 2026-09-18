import { randomBytes } from "node:crypto"

// Shared by POST /me/s3-keys and scripts/connect.ts so both mint keys in the
// same shape.

export const generateAccessKey = (): string => {
  const buf = randomBytes(15)
  return `AKIA${buf.toString("base64").replace(/[+/=]/g, "").toUpperCase().slice(0, 16)}`
}

export const generateSecretKey = (): string => {
  return randomBytes(30).toString("base64").replace(/[+/=]/g, "").slice(0, 40)
}
