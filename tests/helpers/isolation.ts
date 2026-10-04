import type { App } from "./http.ts"
import type { Session } from "./teams.ts"
import { addMember, ROOT, signupOwner, teamWithAdmin } from "./teams.ts"

// One team as the isolation tests see it: its host, its id, an admin and a
// plain member, both signed in on that host.
export type Tenant = { host: string; teamId: number; admin: Session; member: Session }

// root (owner + member "rob"), acme (admin + member "mia"), beta (admin +
// member "bea"). Members are created through /team/users so their emails are
// `<username>@member.example` and their usernames are the names given.
export const threeTeams = async (app: App): Promise<{ root: Tenant; acme: Tenant; beta: Tenant }> => {
  const owner = await signupOwner(app)
  const rob = await addMember(app, ROOT, owner, "rob")
  const a = await teamWithAdmin(app, owner, "acme")
  const mia = await addMember(app, a.host, a.admin, "mia")
  const b = await teamWithAdmin(app, owner, "beta")
  const bea = await addMember(app, b.host, b.admin, "bea")
  return {
    root: { host: ROOT, teamId: 1, admin: owner, member: rob },
    acme: { host: a.host, teamId: a.created.team.id, admin: a.admin, member: mia },
    beta: { host: b.host, teamId: b.created.team.id, admin: b.admin, member: bea },
  }
}
