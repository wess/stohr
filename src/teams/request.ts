// Per-request team resolution. withTeams wraps the whole fetch handler (like
// withSecurityHeaders) so a suspended or unknown team is answered before any
// route runs, and stashes the result on the Request object where teamFor
// reads it back from inside pipes and handlers.

import type { Connection } from "@atlas/db"
import type { Cidr } from "../security/proxies.ts"
import { effectiveHost } from "./host.ts"
import type { Team } from "./resolve.ts"
import { ROOT_TEAM_ID, rootSentinel, rootTeam, teamBySlug } from "./resolve.ts"
import { parseHost } from "./slug.ts"
import type { HostConfig } from "./urls.ts"
import { teamBaseUrl } from "./urls.ts"

export type ResolvedTeam = {
  team: Team
  isRoot: boolean
  // null when the request did not pass through withTeams
  baseUrl: string | null
}

const STASH = "stohrTeam"

type Stashed = Request & { [STASH]?: ResolvedTeam }

// liveness probes and the tls allow-list never touch the database and are
// answered on any host; the root team is what they see
const INFRA_PATHS = new Set(["/healthz", "/readyz", "/metrics", "/internal/tls/allow"])

const FALLBACK: ResolvedTeam = { team: rootSentinel(), isRoot: true, baseUrl: null }

export const teamFor = (req: Request): ResolvedTeam => (req as Stashed)[STASH] ?? FALLBACK

// base url for links that land on the same host the request came in on
export const requestBaseUrl = (req: Request, fallback: string): string =>
  teamFor(req).baseUrl ?? fallback.replace(/\/$/, "")

type Fetch = (req: Request, server?: unknown) => Response | Promise<Response>

const reject = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } })

export const withTeams =
  (
    db: Connection,
    fetch: Fetch,
    cfg: HostConfig & { trusted?: Cidr[] },
  ): ((req: Request, server?: unknown) => Promise<Response>) =>
  async (req, server) => {
    const path = new URL(req.url).pathname
    if (INFRA_PATHS.has(path)) return fetch(req, server)

    const parsed = parseHost(effectiveHost(req, cfg.trusted), cfg.rootDomain)
    if (parsed.kind === "invalid") return reject(404, "Unknown team")

    const team = parsed.kind === "team" ? await teamBySlug(db, parsed.slug) : await rootTeam(db)
    if (!team) return reject(404, "Unknown team")
    if (team.suspended_at) return reject(403, "This team is suspended. Contact the instance owner.")

    ;(req as Stashed)[STASH] = {
      team,
      isRoot: team.id === ROOT_TEAM_ID,
      baseUrl: teamBaseUrl(team, cfg),
    }
    return fetch(req, server)
  }
