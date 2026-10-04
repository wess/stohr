// Creating a user on someone's behalf: the owner making a team's first admin,
// or a team admin adding a member. Without a password the account gets a
// random unguessable one and a one-time set-password link (the password
// reset machinery) on the team's own host.

import { hash } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from } from "@atlas/db"
import { uniqueUsername } from "../auth/external.ts"
import { issuePasswordReset, passwordResetUrl } from "../auth/password.ts"
import type { Emailer } from "../email/index.ts"
import { passwordResetEmail } from "../email/templates/password.ts"
import { randomToken } from "../util/token.ts"
import { isEmail, isValidUsername, normalizeUsername } from "../util/username.ts"
import type { Team } from "./resolve.ts"
import type { HostConfig } from "./urls.ts"
import { teamBaseUrl } from "./urls.ts"

export type NewTeamUser = {
  email: string
  name?: string | null
  username?: string | null
  password?: string | null
  teamAdmin: boolean
}

export type CreatedUser = {
  id: number
  email: string
  username: string
  name: string
  team_id: number
  team_admin: boolean
}

export type CreateResult =
  | { ok: true; user: CreatedUser }
  | { ok: false; status: 409 | 422; error: string; field?: "email" | "username" }

export const createTeamUser = async (db: Connection, team: Team, input: NewTeamUser): Promise<CreateResult> => {
  const email = input.email.trim().toLowerCase()
  if (!isEmail(email)) return { ok: false, status: 422, error: "Invalid email format" }
  if (input.password != null && input.password.length < 8) {
    return { ok: false, status: 422, error: "Password must be at least 8 characters" }
  }

  // usernames and emails are globally unique (public /p/:username urls)
  const emailTaken = await db.one(
    from("users")
      .where(q => q("email").equals(email))
      .select("id"),
  )
  if (emailTaken) return { ok: false, status: 409, error: "Email already in use", field: "email" }

  let username: string
  if (input.username) {
    username = normalizeUsername(input.username)
    if (!isValidUsername(username)) {
      return {
        ok: false,
        status: 422,
        error: "Username must be 3-32 chars, lowercase letters, digits, and underscores",
      }
    }
    const taken = await db.one(
      from("users")
        .where(q => q("username").equals(username))
        .select("id"),
    )
    if (taken) return { ok: false, status: 409, error: "Username already in use", field: "username" }
  } else {
    username = await uniqueUsername(db, email.split("@")[0] ?? "")
  }

  const name = input.name?.trim() || username
  const hashed = await hash(input.password ?? randomToken(32))
  const inserted = (await db.execute(
    from("users")
      .insert({
        email,
        username,
        name,
        password: hashed,
        is_owner: false,
        team_id: team.id,
        team_admin: input.teamAdmin,
      })
      .returning("id", "email", "username", "name", "team_id", "team_admin"),
  )) as CreatedUser[]
  const user = inserted[0]!
  return { ok: true, user: { ...user, team_id: Number(user.team_id) } }
}

// One-time link to set the first password, mailed when delivery is possible.
// The plaintext url is always returned: the admin creating the account is
// the designed channel when email is off.
export const issueSetPasswordLink = async (
  db: Connection,
  emailer: Emailer,
  hosts: HostConfig,
  team: Team,
  user: Pick<CreatedUser, "id" | "email" | "name">,
): Promise<{ url: string; emailed: boolean }> => {
  const { token } = await issuePasswordReset(db, user.id, null)
  const url = passwordResetUrl(teamBaseUrl(team, hosts), token)
  const tpl = passwordResetEmail({ name: user.name, resetUrl: url })
  const sent = await emailer.send({ to: user.email, subject: tpl.subject, html: tpl.html, text: tpl.text })
  return { url, emailed: sent.ok && !sent.logged }
}
