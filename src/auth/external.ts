import { hash } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { randomToken } from "../util/token.ts"
import { isValidUsername, normalizeUsername } from "../util/username.ts"
import { resolvePendingCollabs } from "./index.ts"

export type ExternalProfile = {
  provider: "oidc" | "ldap" | "google" | "github"
  subject: string
  email: string | null
  display_name: string | null
  preferred_username?: string | null
}

type LocalUser = {
  id: number
  email: string
  username: string
  name: string
  is_owner: boolean
  deleted_at: string | null
}

const suggestUsernameFrom = (profile: ExternalProfile): string => {
  const raw = (profile.preferred_username ?? profile.email?.split("@")[0] ?? `user-${randomToken(3)}`).toLowerCase()
  const cleaned = raw
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
  const base = cleaned.length < 3 ? `user_${cleaned}`.padEnd(3, "_") : cleaned.slice(0, 32)
  return base
}

const uniqueUsername = async (db: Connection, base: string): Promise<string> => {
  let candidate = normalizeUsername(base)
  if (!isValidUsername(candidate)) candidate = `user_${randomToken(4)}`
  for (let i = 0; i < 50; i++) {
    const taken = await db.one(
      from("users")
        .where(q => q("username").equals(candidate))
        .select("id"),
    )
    if (!taken) return candidate
    const suffix = randomToken(2)
    candidate = `${base.slice(0, 32 - suffix.length - 1)}_${suffix}`
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
// the local account first will get auto-linked on first SSO login.
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
        .select("id", "email", "username", "name", "is_owner", "deleted_at"),
    )) as LocalUser | null
    if (!user) throw new Error("Linked external identity points to a missing user")
    await touchIdentity(db, existing.id)
    return { user, created: false }
  }

  if (profile.email) {
    const byEmail = (await db.one(
      from("users")
        .where(q => q("email").equals(profile.email!.toLowerCase()))
        .select("id", "email", "username", "name", "is_owner", "deleted_at"),
    )) as LocalUser | null
    if (byEmail) {
      const linked = (await db.execute(
        from("external_identities")
          .insert({
            user_id: byEmail.id,
            provider: profile.provider,
            subject: profile.subject,
            email: profile.email,
            display_name: profile.display_name,
            last_login_at: raw("NOW()"),
          })
          .returning("id"),
      )) as Array<{ id: number }>
      void linked
      return { user: byEmail, created: false }
    }
  }

  if (!opts.autoProvision) {
    throw new Error("No matching local account and auto-provision is disabled")
  }
  if (!profile.email) {
    throw new Error("Cannot auto-provision without an email claim")
  }

  const isFirstUser = !(await db.one(from("users").select("id").limit(1)))
  const baseUsername = suggestUsernameFrom(profile)
  const username = await uniqueUsername(db, baseUsername)
  // Generate a random throwaway password — the user authenticates through
  // the IdP, never password-locally. They can set one later via password
  // reset if they want to (the email is already verified by the IdP).
  const passwordHash = await hash(randomToken(32))

  const inserted = (await db.execute(
    from("users")
      .insert({
        email: profile.email.toLowerCase(),
        username,
        name: profile.display_name ?? profile.email.split("@")[0] ?? username,
        password: passwordHash,
        is_owner: isFirstUser,
      })
      .returning("id", "email", "username", "name", "is_owner", "deleted_at"),
  )) as Array<LocalUser>
  const user = inserted[0]!

  await db.execute(
    from("external_identities").insert({
      user_id: user.id,
      provider: profile.provider,
      subject: profile.subject,
      email: profile.email,
      display_name: profile.display_name,
      last_login_at: raw("NOW()"),
    }),
  )

  await resolvePendingCollabs(db, user.id, profile.email.toLowerCase())

  return { user, created: true }
}
