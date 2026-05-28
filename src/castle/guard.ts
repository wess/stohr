import { halt } from "@atlas/server"
import type { PipeFn } from "@atlas/server"

const constantTimeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export const requireCastleToken = (expected: string): PipeFn =>
  async (conn) => {
    const header = conn.headers.get("authorization")
    if (!header?.startsWith("Bearer ")) {
      return halt(conn, 401, { error: "Missing bearer token" })
    }
    const presented = header.slice(7).trim()
    if (!constantTimeEquals(presented, expected)) {
      return halt(conn, 401, { error: "Invalid token" })
    }
    return conn
  }
