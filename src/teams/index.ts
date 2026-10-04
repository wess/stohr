// Multi-tenancy. A team is a hard boundary on one instance, reached on its
// own subdomain under ROOT_DOMAIN; team 1 (root) is the owner's team and the
// control plane. docs/TEAMS.md is the spec.
//
// Route code reads the host's team with teamFor(c.request); requireAuth
// already refused any credential whose user is not in that team, so
// `teamFor(c.request).team.id` and `c.assigns.auth.teamId` always agree.

export { adminTeamRoutes, sweepDeletedTeams } from "./admin.ts"
export { rootOnly, rootOnlyRoutes, teamAdminOnly } from "./guards.ts"
export { effectiveHost, isLoopbackPeer, isTrustedPeer, socketPeer } from "./host.ts"
export type { TeamUsage } from "./members.ts"
export {
  computeTeamUsage,
  countActiveTeamAdmins,
  countTeamUsers,
  inTeam,
  sameTeam,
  teamIdOf,
  unlessLastAdmin,
  userInTeam,
  usersInTeamSql,
} from "./members.ts"
export type { ResolvedTeam } from "./request.ts"
export { requestBaseUrl, teamFor, withTeams } from "./request.ts"
export type { Team } from "./resolve.ts"
export { clearTeamCache, ROOT_TEAM_ID, rootTeam, teamById, teamBySlug } from "./resolve.ts"
export { teamRoutes } from "./routes.ts"
export type { ParsedHost } from "./slug.ts"
export { isReservedSlug, isValidSlug, normalizeSlug, parseHost, RESERVED_SLUGS, slugProblem } from "./slug.ts"
export { tlsAllowRoutes } from "./tls.ts"
export type { HostConfig } from "./urls.ts"
export { teamBaseUrl, teamHostname } from "./urls.ts"
export type { CreatedUser, NewTeamUser } from "./users.ts"
export { createTeamUser, issueSetPasswordLink } from "./users.ts"
