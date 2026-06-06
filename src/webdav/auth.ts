import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { APP_TOKEN_PREFIX, hashToken } from "../auth/guard.ts"

// WebDAV clients (macOS Finder, Windows File Explorer, RFC-compliant
// clients) speak HTTP Basic — they cannot present a Bearer token. So we map
// Basic credentials onto the credentials Stohr already has: the username is
// the account email and the password is a Personal Access Token
// (stohr_pat_…). The PAT is verified against the apps table using the exact
// same SHA-256 hashing requireAuth uses, so revoking the PAT from
// Settings → Apps revokes WebDAV access too — no separate credential store.

export type WebdavAuth = {
  userId: number
  email: string
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
  if (!parsed.pass.startsWith(APP_TOKEN_PREFIX)) return null

  const email = parsed.user.trim().toLowerCase()
  const user = (await db.one(
    from("users")
      .where(q => q("email").equals(email))
      .where(q => q("deleted_at").isNull())
      .where(q => q("suspended_at").isNull())
      .select("id", "email", "username"),
  )) as { id: number; email: string; username: string } | null
  if (!user) return null

  // Same hashing requireAuth uses for Bearer PATs — look the row up by hash,
  // then confirm it belongs to the resolved user. A constant-time DB lookup
  // by hash is the standard pattern here (the hash itself is the secret).
  const tokenHash = hashToken(parsed.pass)
  const app = (await db.one(
    from("apps")
      .where(q => q("token_hash").equals(tokenHash))
      .where(q => q("user_id").equals(user.id))
      .select("id"),
  )) as { id: number } | null
  if (!app) return null

  void db
    .execute(
      from("apps")
        .where(q => q("id").equals(app.id))
        .update({ last_used_at: raw("NOW()") }),
    )
    .catch(() => {})

  return { userId: user.id, email: user.email, username: user.username }
}
