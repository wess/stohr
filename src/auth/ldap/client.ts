import { Client } from "ldapts"
import type { LdapConfig } from "./config.ts"

export type LdapUser = {
  dn: string
  username: string | null
  email: string | null
  display_name: string | null
}

// Escape LDAP filter input per RFC 4515. Without this, a username with a
// `*` or `)` would let the attacker rewrite the search filter.
const escapeFilter = (raw: string): string => {
  let out = ""
  for (const ch of raw) {
    const code = ch.charCodeAt(0)
    if (ch === "*") out += "\\2a"
    else if (ch === "(") out += "\\28"
    else if (ch === ")") out += "\\29"
    else if (ch === "\\") out += "\\5c"
    else if (code === 0) out += "\\00"
    else out += ch
  }
  return out
}

const attrValue = (raw: unknown): string | null => {
  if (raw == null) return null
  if (Array.isArray(raw)) return raw.length > 0 ? String(raw[0]) : null
  return String(raw)
}

// Bind as the service account, search for the user, then re-bind as the
// user with the candidate password. Two binds; one TCP connection.
export const authenticateLdap = async (
  cfg: LdapConfig,
  identity: string,
  password: string,
): Promise<LdapUser> => {
  if (!cfg.url || !cfg.user_search_base) {
    throw new Error("LDAP is not configured")
  }
  if (!password) throw new Error("Password required")

  const client = new Client({ url: cfg.url, timeout: 10_000, connectTimeout: 5_000 })
  try {
    if (cfg.start_tls) {
      await client.startTLS({})
    }
    if (cfg.bind_dn) {
      await client.bind(cfg.bind_dn, cfg.bind_password ?? "")
    }

    const safeIdentity = escapeFilter(identity)
    const filter = cfg.user_filter.replace(/\{username\}/g, safeIdentity)

    const { searchEntries } = await client.search(cfg.user_search_base, {
      scope: "sub",
      filter,
      attributes: [cfg.email_attr, cfg.name_attr, cfg.username_attr, "dn"],
      sizeLimit: 2,
    })
    if (searchEntries.length === 0) throw new Error("Invalid credentials")
    if (searchEntries.length > 1) throw new Error("LDAP filter matched multiple users")
    const entry = searchEntries[0]!

    if (cfg.bind_dn) await client.unbind()
    const userClient = cfg.bind_dn ? new Client({ url: cfg.url, timeout: 10_000, connectTimeout: 5_000 }) : client
    try {
      if (cfg.bind_dn && cfg.start_tls) await userClient.startTLS({})
      await userClient.bind(entry.dn, password)
    } finally {
      if (cfg.bind_dn) {
        try { await userClient.unbind() } catch { /* ignore */ }
      }
    }

    return {
      dn: entry.dn,
      username: attrValue(entry[cfg.username_attr]),
      email: attrValue(entry[cfg.email_attr]),
      display_name: attrValue(entry[cfg.name_attr]),
    }
  } catch (err) {
    const msg = (err as Error).message ?? ""
    // ldapts surfaces "InvalidCredentialsError" on bind failure. Map it to
    // a generic message so we don't leak whether the user exists or not.
    if (/InvalidCredentials|49/i.test(msg)) throw new Error("Invalid credentials")
    throw err
  } finally {
    try { await client.unbind() } catch { /* ignore */ }
  }
}
