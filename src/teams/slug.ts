// A team slug is the left-most DNS label of its host, so it has to be a
// valid lowercase label. Names that collide with infrastructure hosts or
// that would look official are refused at creation; "root" is the owner's
// team and never a subdomain.

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "root",
  "www",
  "api",
  "admin",
  "app",
  "mail",
  "static",
  "s3",
  "webdav",
  "mcp",
  "cdn",
  "assets",
  "docs",
  "status",
  "ftp",
  "smtp",
  "imap",
  "pop",
  "mx",
  "ns",
  "ns1",
  "ns2",
  "autoconfig",
  "autodiscover",
  "localhost",
  "internal",
  "dev",
  "staging",
  "test",
  "login",
  "auth",
  "oauth",
  "sso",
  "support",
  "help",
  "blog",
  "team",
  "teams",
  "owner",
  "system",
  "stohr",
])

export const normalizeSlug = (raw: string): string => raw.trim().toLowerCase()

// shape only — a reserved word is a valid label that we refuse separately
export const isValidSlug = (slug: string): boolean => slug.length >= 2 && slug.length <= 63 && SLUG_RE.test(slug)

export const isReservedSlug = (slug: string): boolean => RESERVED_SLUGS.has(slug)

export const slugProblem = (slug: string): string | null => {
  if (!isValidSlug(slug))
    return "slug must be 2-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen"
  if (isReservedSlug(slug)) return "slug is reserved"
  return null
}

export type ParsedHost = { kind: "root" } | { kind: "team"; slug: string } | { kind: "invalid" }

// Decide what a hostname means under ROOT_DOMAIN. Anything that is not
// under the root domain at all (localhost, an ip, a health-check hostname)
// is the root team. Exactly one label under it names a team; anything
// deeper, malformed or reserved is nothing we serve — in particular
// root.<ROOT_DOMAIN> is not a second name for the root team, whose row
// carries that slug.
export const parseHost = (hostname: string, rootDomain: string | null): ParsedHost => {
  if (!rootDomain) return { kind: "root" }
  const root = rootDomain.trim().toLowerCase()
  const host = hostname.trim().toLowerCase()
  if (!root || host === root) return { kind: "root" }
  if (!host.endsWith(`.${root}`)) return { kind: "root" }
  const label = host.slice(0, -(root.length + 1))
  if (!isValidSlug(label) || isReservedSlug(label)) return { kind: "invalid" }
  return { kind: "team", slug: label }
}
