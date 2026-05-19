import { createHash, randomBytes } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"

// WebDAV clients (macOS Finder, Windows File Explorer, RFC-compliant
// clients) speak HTTP Basic. Stohr's regular auth uses JWT/PAT/OAuth which
// these clients cannot present. So we mint a separate per-user WebDAV
// password — distinct from the account password — and check it inline.

export const WEBDAV_TOKEN_PREFIX = "stohr_dav_"

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex")

export const generateWebdavToken = (): string => {
  const raw = randomBytes(24).toString("base64url")
  return `${WEBDAV_TOKEN_PREFIX}${raw}`
}

export type WebdavAuth = {
  userId: number
  username: string
}

const parseBasicAuth = (header: string): { user: string; pass: string } | null => {
  if (!header.startsWith("Basic ")) return null
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf-8")
    const sep = decoded.indexOf(":")
    if (sep === -1) return null
    return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) }
  } catch {
    return null
  }
}

export const authenticateWebdav = async (db: Connection, authHeader: string | null): Promise<WebdavAuth | null> => {
  if (!authHeader) return null
  const parsed = parseBasicAuth(authHeader)
  if (!parsed) return null

  const user = await db.one(
    from("users")
      .where(q => q("username").equals(parsed.user))
      .where(q => q("deleted_at").isNull())
      .select("id", "username"),
  ) as { id: number; username: string } | null
  if (!user) return null

  const creds = await db.one(
    from("webdav_credentials")
      .where(q => q("user_id").equals(user.id))
      .where(q => q("enabled").equals(true))
      .select("token_hash"),
  ) as { token_hash: string | null } | null
  if (!creds?.token_hash) return null

  const hashed = hashToken(parsed.pass)
  // Timing-safe compare; both hashes are 64-char hex (sha256) and so
  // identical length always.
  if (hashed.length !== creds.token_hash.length) return null
  let diff = 0
  for (let i = 0; i < hashed.length; i++) diff |= hashed.charCodeAt(i) ^ creds.token_hash.charCodeAt(i)
  if (diff !== 0) return null

  void db.execute(
    from("webdav_credentials").where(q => q("user_id").equals(user.id)).update({ last_used_at: raw("NOW()") }),
  ).catch(() => {})

  return { userId: user.id, username: user.username }
}

export const hashWebdavToken = (token: string): string => hashToken(token)
