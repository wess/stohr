import { hash } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { ROOT_TEAM_ID } from "../teams/resolve.ts"
import { randomToken } from "../util/token.ts"
import { isValidUsername, normalizeUsername } from "../util/username.ts"
import { resolvePendingCollabs } from "./index.ts"

export type ExternalProfile = {
  provider: "oidc" | "ldap" | "google" | "github"
  subject: string
  email: string | null
  // whether the provider vouches for the address. an unverified email is a
  // display string: it never links to an existing account, never resolves
  // collaborator invites, and never seeds a new one.
  email_verified: boolean
  display_name: string | null
  preferred_username?: string | null
}

type LocalUser = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
  team_id: number
  deleted_at: string | null
}

// External sign-in (oidc, ldap, social) is a root-team surface: tenant users
// log in with a password or passkey on their own host. A provider must never
// be able to land someone in a tenant account.
const ROOT_ONLY_ERROR = "External sign-in is only available for root team accounts"

const suggestUsernameFrom = (profile: ExternalProfile): string => {
  const raw = (profile.preferred_username ?? profile.email?.split("@")[0] ?? `user-${randomToken(3)}`).toLowerCase()
  const cleaned = raw
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
  const base = cleaned.length < 3 ? `user_${cleaned}`.padEnd(3, "_") : cleaned.slice(0, 32)
  return base
}

// Allocate a username nobody holds, starting from what the provider
// suggested and falling back to a random handle when that isn't usable.
export const uniqueUsername = async (db: Connection, base: string): Promise<string> => {
  let root = normalizeUsername(base)
  if (!isValidUsername(root)) root = `user_${randomToken(4)}`
  let candidate = root
  for (let i = 0; i < 50; i++) {
    const taken = await db.one(
      from("users")
        .where(q => q("username").equals(candidate))
        .select("id"),
    )
    if (!taken) return candidate
    const suffix = randomToken(2)
    candidate = `${root.slice(0, 32 - suffix.length - 1)}_${suffix}`
  }
  throw new Error("Could not allocate a unique username")
}

const touchIdentity = async (db: Connection, identityId: number) => {
  await db.execute(
    from("external_identities")
      .where(q => q("id").equals(identityId))
      .update({ last_login_at: raw("NOW()") }),
  )
}

// Find or create a local user from an external provider profile. The
// (provider, subject) pair is the durable identity key — emails can change
// on the IdP side, so we never use email as the primary match. We do fall
// back to email when no identity link exists yet, so an admin who created
// the local account first will get auto-linked on first SSO login — but only
// for an address the provider has verified, or anyone who can type a
// victim's email into their IdP profile inherits the victim's account.
export const upsertFromExternal = async (
  db: Connection,
  profile: ExternalProfile,
  opts: { autoProvision: boolean },
): Promise<{ user: LocalUser; created: boolean }> => {
  const existing = (await db.one(
    from("external_identities")
      .where(q => q("provider").equals(profile.provider))
      .where(q => q("subject").equals(profile.subject))
      .select("id", "user_id"),
  )) as { id: number; user_id: number } | null

  if (existing) {
    const user = (await db.one(
      from("users")
        .where(q => q("id").equals(existing.user_id))
        .select("id", "email", "username", "name", "is_owner", "team_id", "deleted_at"),
    )) as LocalUser | null
    if (!user) throw new Error("Linked external identity points to a missing user")
    if (Number(user.team_id) !== ROOT_TEAM_ID) throw new Error(ROOT_ONLY_ERROR)
    await touchIdentity(db, existing.id)
    return { user, created: false }
  }

  const email = profile.email?.toLowerCase() ?? null
  const verifiedEmail = email && profile.email_verified === true ? email : null

  if (verifiedEmail) {
    const byEmail = (await db.one(
      from("users")
        .where(q => q("email").equals(verifiedEmail))
        .where(q => q("team_id").equals(ROOT_TEAM_ID))
        .select("id", "email", "username", "name", "is_owner", "team_id", "deleted_at"),
    )) as LocalUser | null
    if (byEmail) {
      await db.execute(
        from("external_identities").insert({
          user_id: byEmail.id,
          provider: profile.provider,
          subject: profile.subject,
          email: verifiedEmail,
          display_name: profile.display_name,
          last_login_at: raw("NOW()"),
        }),
      )
      return { user: byEmail, created: false }
    }
  }

  if (!opts.autoProvision) {
    throw new Error("No matching local account and auto-provision is disabled")
  }
  if (!email) {
    throw new Error("Cannot auto-provision without an email claim")
  }
  // The address becomes the account's unique email and its password-reset
  // channel; seeding it unverified would let the next verified login for
  // the same address land in this account.
  if (!verifiedEmail) {
    throw new Error("Identity provider did not mark the email as verified — cannot create an account")
  }

  const isFirstUser = !(await db.one(from("users").select("id").limit(1)))
  const baseUsername = suggestUsernameFrom(profile)
  const username = await uniqueUsername(db, baseUsername)
  // Generate a random throwaway password — the user authenticates through
  // the IdP, never password-locally. They can set one later via password
  // reset if they want to (the email is verified by the IdP).
  const passwordHash = await hash(randomToken(32))

  const inserted = (await db.execute(
    from("users")
      .insert({
        email: verifiedEmail,
        username,
        name: profile.display_name ?? verifiedEmail.split("@")[0] ?? username,
        password: passwordHash,
        is_owner: isFirstUser,
        team_id: ROOT_TEAM_ID,
      })
      .returning("id", "email", "username", "name", "is_owner", "team_id", "deleted_at"),
  )) as Array<LocalUser>
  const user = inserted[0]!

  await db.execute(
    from("external_identities").insert({
      user_id: user.id,
      provider: profile.provider,
      subject: profile.subject,
      email: verifiedEmail,
      display_name: profile.display_name,
      last_login_at: raw("NOW()"),
    }),
  )

  await resolvePendingCollabs(db, user.id, verifiedEmail)

  return { user, created: true }
}
