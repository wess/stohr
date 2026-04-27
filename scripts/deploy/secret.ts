import { randomBytes } from "node:crypto"

export const generateSecret = (bytes = 32) =>
  randomBytes(bytes).toString("hex")
