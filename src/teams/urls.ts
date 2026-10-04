// Absolute links (emails, share urls, oauth issuer) must point at the host
// the recipient's team lives on, never blindly at APP_URL. The root team is
// APP_URL; every other team is <slug>.<ROOT_DOMAIN> with APP_URL's scheme
// and port, so http://acme.localhost:3001 falls out in dev and
// https://acme.storage.example in prod.

import type { Team } from "./resolve.ts"
import { ROOT_TEAM_ID } from "./resolve.ts"

export type HostConfig = {
  // null = single tenant, host routing off
  rootDomain: string | null
  // public url of the root team / the whole instance when single tenant
  appUrl: string
}

const strip = (url: string): string => url.replace(/\/$/, "")

export const teamBaseUrl = (team: Pick<Team, "id" | "slug">, cfg: HostConfig): string => {
  const app = strip(cfg.appUrl)
  if (team.id === ROOT_TEAM_ID || !cfg.rootDomain) return app
  let scheme = "https:"
  let port = ""
  try {
    const u = new URL(cfg.appUrl)
    scheme = u.protocol
    port = u.port ? `:${u.port}` : ""
  } catch {
    // keep the https default
  }
  return `${scheme}//${team.slug}.${cfg.rootDomain.toLowerCase()}${port}`
}

// hostname (no scheme, no port) a team answers on; null when the team has
// no host of its own
export const teamHostname = (team: Pick<Team, "id" | "slug">, cfg: HostConfig): string | null => {
  if (team.id === ROOT_TEAM_ID) {
    if (cfg.rootDomain) return cfg.rootDomain.toLowerCase()
    try {
      return new URL(cfg.appUrl).hostname.toLowerCase()
    } catch {
      return null
    }
  }
  return cfg.rootDomain ? `${team.slug}.${cfg.rootDomain.toLowerCase()}` : null
}
