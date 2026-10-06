import { randomUUID } from "node:crypto"
import { hash, token, verify } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { get, json, pipeline, post } from "@atlas/server"
import { sendSystem } from "../messages/system.ts"
import { logEvent } from "../security/audit.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import { issueSession } from "../security/sessions.ts"
import { claimTotp } from "../security/totpclaims.ts"
import { inTeam, teamIdOf } from "../teams/members.ts"
import { teamFor } from "../teams/request.ts"
import { parseJson } from "../util/json/index.ts"
import { limitBody } from "../util/limitbody/index.ts"
import { sha256Hex } from "../util/token.ts"
import { isEmail, isValidUsername, normalizeUsername } from "../util/username.ts"

type UserRow = {
  id: number
  email: string
  username: string
  name: string
  password: string
  is_owner: boolean
  team_id: number
  totp_enabled: boolean
  totp_secret: string | null
  totp_backup_codes: string | null
}

type AuthUser = { id: number; email: string; username: string; name: string; is_owner: boolean }

// Pre-computed argon2id hash of a random throwaway string. Used to make the
// "user not found" path spend the same wall-clock time as the "bad password"
// path so an attacker can't enumerate accounts by timing the response.
const DECOY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$RetE64xcIWBR/OUrFhs4qiRpTMgEo2w3Z6lis33NPx8$fVAJ65lFBof5QYfFvuLLza/XeSZd8jCGzSd4fzu32nI"

const MFA_CHALLENGE_TTL_SECONDS = 300

// The challenge JWT on its own is replayable for its whole TTL; a row keyed
// on its jti makes it single-use. webauthn_challenges already has the right
// shape (opaque id, user, kind, expiry) and the same expiry sweep.
const issueMfaChallenge = async (db: Connection, secret: string, userId: number): Promise<string> => {
  const jti = randomUUID()
  await db.execute(
    from("webauthn_challenges").insert({
      challenge: jti,
      user_id: userId,
      kind: "mfa",
      expires_at: new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000),
    }),
  )
  return token.sign({ kind: "mfa", uid: userId, jti }, secret, { expiresIn: MFA_CHALLENGE_TTL_SECONDS })
}

const mfaChallengeOpen = async (db: Connection, jti: string, userId: number): Promise<boolean> => {
  const row = (await db.one(
    from("webauthn_challenges")
      .where(q => q("challenge").equals(jti))
      .where(q => q("kind").equals("mfa"))
      .where(q => q("user_id").equals(userId))
      .select("expires_at"),
  )) as { expires_at: string } | null
  return !!row && new Date(row.expires_at).getTime() >= Date.now()
}

// delete-returning so two concurrent completions can't both win
const consumeMfaChallenge = async (db: Connection, jti: string): Promise<boolean> => {
  const rows = (await db.execute(
    from("webauthn_challenges")
      .where(q => q("challenge").equals(jti))
      .where(q => q("kind").equals("mfa"))
      .del()
      .returning("challenge"),
  )) as Array<{ challenge: string }>
  return rows.length > 0
}

const userCount = async (db: Connection) => {
  const any = await db.one(from("users").select("id").limit(1))
  return any ? 1 : 0
}

// Pending grants keyed on an email bind to the account that proves the
// address — but only grants issued from the account's own team. A grant from
// another team stays pending: binding it would hand this user a row that
// fileAccess rejects anyway, while still listing its name under /shared.
export const resolvePendingCollabs = async (db: Connection, userId: number, email: string) => {
  const teamId = await teamIdOf(db, userId)
  if (teamId === null) return
  const pending = (await db.all(
    from("collaborations")
      .where(q => q("user_id").isNull())
      .where(q => q("email").ilike(email.replace(/[\\%_]/g, c => `\\${c}`)))
      .where(inTeam("invited_by", teamId))
      .select("id", "resource_type", "resource_id"),
  )) as Array<{ id: number; resource_type: string; resource_id: number }>

  for (const row of pending) {
    const existing = (await db.one(
      from("collaborations")
        .where(q => q("resource_type").equals(row.resource_type))
        .where(q => q("resource_id").equals(row.resource_id))
        .where(q => q("user_id").equals(userId))
        .select("id"),
    )) as { id: number } | null

    if (existing) {
      await db.execute(
        from("collaborations")
          .where(q => q("id").equals(row.id))
          .del(),
      )
    } else {
      await db.execute(
        from("collaborations")
          .where(q => q("id").equals(row.id))
          .update({
            user_id: userId,
            email: null,
            accepted_at: raw("NOW()"),
          }),
      )
    }
  }
}

const consumeBackupCode = async (
  db: Connection,
  userId: number,
  storedCodes: string[],
  candidate: string,
): Promise<boolean> => {
  for (let i = 0; i < storedCodes.length; i++) {
    const ok = await verify(candidate, storedCodes[i]!).catch(() => false)
    if (ok) {
      const remaining = [...storedCodes.slice(0, i), ...storedCodes.slice(i + 1)]
      const claimed = (await db.execute(
        from("users")
          .where(q => q("id").equals(userId))
          .where(q => q("totp_backup_codes").equals(JSON.stringify(storedCodes)))
          .update({ totp_backup_codes: JSON.stringify(remaining) })
          .returning("id"),
      )) as Array<{ id: number }>
      return claimed.length === 1
    }
  }
  return false
}

export const authRoutes = (db: Connection, secret: string) => {
  const api = pipeline(limitBody(), parseJson)

  return [
    get("/setup", async c => {
      // only the root team bootstraps itself; a tenant's first user is made
      // by the owner, so its host never shows the setup screen
      const count = await userCount(db)
      const { team, isRoot } = teamFor(c.request)
      return json(c, 200, {
        needsSetup: isRoot && count === 0,
        is_root: isRoot,
        team: { id: team.id, slug: team.slug, name: team.name },
      })
    }),

    post(
      "/signup",
      api(async c => {
        const ip = clientIp(c.request)
        const ua = userAgent(c.request)

        const ipRate = await checkRate(db, `signup:ip:${ip}`, 10, 3600)
        if (!ipRate.ok) {
          logEvent(db, { event: "signup.rate_limited", ip, userAgent: ua })
          return json(c, 429, {
            error: "Too many signup attempts. Try again later.",
            retry_after: ipRate.retryAfterSeconds,
          })
        }

        const body = c.body as {
          name?: string
          email?: string
          username?: string
          password?: string
          invite_token?: string
          inviteToken?: string
        }

        const name = body.name?.trim()
        const emailInput = body.email?.trim().toLowerCase()
        const usernameInput = body.username?.trim()
        const username = usernameInput ? normalizeUsername(usernameInput) : ""
        const password = body.password
        const inviteToken = body.invite_token ?? body.inviteToken

        if (!username || !password) {
          return json(c, 422, { error: "username and password are required" })
        }
        if (emailInput && !isEmail(emailInput)) return json(c, 422, { error: "Invalid email format" })
        if (!isValidUsername(username)) {
          return json(c, 422, { error: "Username must be 3-32 chars, lowercase letters, digits, and underscores" })
        }
        if (password.length < 8) return json(c, 422, { error: "Password must be at least 8 characters" })

        // Email is optional on a private network. Synthesize a unique placeholder
        // so the NOT NULL/UNIQUE column and email-keyed lookups keep working.
        const email = emailInput || `${username}@storage.local`
        const displayName = name || username

        // The first account on the instance becomes the owner — on the root
        // host only. Tenant hosts never self-bootstrap: their users come
        // from a team admin, directly or through an invite for that team.
        const host = teamFor(c.request)
        const hashed = await hash(password)
        const created = await db.transaction(async tx => {
          // serialize setup and invite consumption on the host's team
          await tx.execute({ text: "SELECT id FROM teams WHERE id = $1 FOR UPDATE", values: [host.team.id] })
          const isFirstUser = host.isRoot && (await userCount(tx)) === 0

          let invite: { id: number; email: string | null; used_at: string | null; team_id: number } | null = null
          if (!isFirstUser) {
            if (!inviteToken) {
              return {
                error: json(c, 403, {
                  error: host.isRoot ? "Invite token required" : "Signup on this team is by invitation only",
                }),
              }
            }
            invite = (await tx.one(
              from("invites")
                .where(q => q("token_hash").equals(sha256Hex(inviteToken)))
                .select("id", "email", "used_at", "team_id"),
            )) as { id: number; email: string | null; used_at: string | null; team_id: number } | null
            // an invite for another team is indistinguishable from a bad one
            if (!invite || Number(invite.team_id) !== host.team.id) {
              return { error: json(c, 403, { error: "Invalid invite token" }) }
            }
            if (invite.used_at) return { error: json(c, 403, { error: "Invite already used" }) }
            if (invite.email && invite.email.toLowerCase() !== email) {
              return { error: json(c, 403, { error: "Invite is bound to a different email" }) }
            }
          }

          const emailTaken = await tx.one(
            from("users")
              .where(q => q("email").equals(email))
              .select("id"),
          )
          if (emailTaken) return { error: json(c, 409, { error: "Email already in use" }) }

          const usernameTaken = await tx.one(
            from("users")
              .where(q => q("username").equals(username))
              .select("id"),
          )
          if (usernameTaken) return { error: json(c, 409, { error: "Username already in use" }) }

          // New accounts have no storage cap (storage_quota_bytes defaults to 0,
          // meaning unlimited). The owner can set a per-user cap from
          // Admin → Users if they want one.
          const inserted = (await tx.execute(
            from("users")
              .insert({
                name: displayName,
                email,
                username,
                password: hashed,
                is_owner: isFirstUser,
                team_id: host.team.id,
              })
              .returning("id", "email", "username", "name", "is_owner"),
          )) as Array<AuthUser>
          const user = inserted[0]!

          if (invite) {
            await tx.execute(
              from("invites")
                .where(q => q("id").equals(invite!.id))
                .update({
                  used_at: raw("NOW()"),
                  used_by: user.id,
                }),
            )
          }

          return { user, invite, isFirstUser }
        })
        if (created.error) return created.error
        const { user, invite, isFirstUser } = created

        // The address was typed into a form. Only an invite that was mailed
        // to that address proves the signer-up can read it, so pending
        // collaborator grants keyed on the email wait for that proof.
        if (invite?.email && invite.email.toLowerCase() === email) {
          await resolvePendingCollabs(db, user.id, email)
        }

        // Welcome message lands in the new account's inbox so the first
        // login shows something. Fire-and-forget; signup must not fail if
        // the messages table or notifier hiccups.
        void sendSystem(
          db,
          user.id,
          isFirstUser ? "Welcome to Stohr — you're the owner" : "Welcome to Stohr",
          isFirstUser
            ? "You created the first account on this instance, so you're the owner.\n\nFrom Admin → Settings you can toggle WebDAV, federation, MCP, and other features. Admin → Users lets you invite others and manage their accounts.\n\nFiles live in My Files (your personal drive) or in Spaces (shared team workspaces)."
            : "Welcome! Your files live in My Files (your personal drive) or in Spaces (shared workspaces you join).\n\nUse Settings → Apps to create a personal access token for SDKs and the mobile app.",
        )

        logEvent(db, {
          userId: user.id,
          event: "signup.ok",
          metadata: { is_first_user: isFirstUser, invite_id: invite?.id ?? null },
          ip,
          userAgent: ua,
        })

        const sess = await issueSession(db, user, secret, { ip, userAgent: ua })
        return json(c, 201, {
          id: user.id,
          email: user.email,
          username: user.username,
          name: user.name,
          is_owner: user.is_owner,
          token: sess.token,
        })
      }),
    ),

    post(
      "/login",
      api(async c => {
        const ip = clientIp(c.request)
        const ua = userAgent(c.request)

        const body = c.body as {
          identity?: string
          email?: string
          username?: string
          password?: string
        }
        const identity = (body.identity ?? body.email ?? body.username ?? "").trim()
        const password = body.password ?? ""
        if (!identity || !password) return json(c, 422, { error: "identity and password are required" })

        const ipRate = await checkRate(db, `login:ip:${ip}`, 30, 900)
        if (!ipRate.ok) {
          logEvent(db, { event: "login.rate_limited", metadata: { scope: "ip", identity }, ip, userAgent: ua })
          return json(c, 429, { error: "Too many attempts. Try again later.", retry_after: ipRate.retryAfterSeconds })
        }
        const idRate = await checkRate(db, `login:id:${identity.toLowerCase()}`, 5, 900)
        if (!idRate.ok) {
          logEvent(db, { event: "login.rate_limited", metadata: { scope: "identity", identity }, ip, userAgent: ua })
          return json(c, 429, {
            error: "Too many attempts for this account. Try again later.",
            retry_after: idRate.retryAfterSeconds,
          })
        }

        const lookup = identity.includes("@") ? identity.toLowerCase() : normalizeUsername(identity)
        // Scoped to the host's team: a user from another team is "no user"
        // here, with the same decoy verify and the same 401 as a stranger.
        const host = teamFor(c.request)
        const user = (await db.one(
          from("users")
            .where(q => (identity.includes("@") ? q("email").equals(lookup) : q("username").equals(lookup)))
            .where(q => q("team_id").equals(host.team.id))
            .select(
              "id",
              "email",
              "username",
              "name",
              "password",
              "is_owner",
              "totp_enabled",
              "totp_secret",
              "totp_backup_codes",
              "deleted_at",
              "suspended_at",
            ),
        )) as (UserRow & { deleted_at: string | null; suspended_at: string | null }) | null

        // Always run a verify, even when the user doesn't exist, so the
        // response timing doesn't leak account existence. The decoy hash is a
        // real argon2id encoding so verify() does the full key derivation.
        const verifyTarget = user?.password ?? DECOY_PASSWORD_HASH
        const verifyOk = await verify(password, verifyTarget).catch(() => false)

        if (!user) {
          logEvent(db, { event: "login.fail", metadata: { reason: "no_user", identity }, ip, userAgent: ua })
          return json(c, 401, { error: "Invalid credentials" })
        }
        if (!verifyOk) {
          logEvent(db, {
            userId: user.id,
            event: "login.fail",
            metadata: { reason: "bad_password" },
            ip,
            userAgent: ua,
          })
          return json(c, 401, { error: "Invalid credentials" })
        }
        return db.transaction(async tx => {
          const current = (await tx.one({
            text: "SELECT * FROM users WHERE id = $1 FOR UPDATE",
            values: [user.id],
          })) as (UserRow & { deleted_at: string | null; suspended_at: string | null }) | null
          if (!current || current.password !== user.password) return json(c, 401, { error: "Invalid credentials" })
          // If the account is mid-grace-window, reject login. The user has the
          // cancel link in their email — they should restore via that, not by
          // logging in (which could be an attacker who triggered the deletion).
          if (current.deleted_at) {
            logEvent(db, {
              userId: current.id,
              event: "login.fail",
              metadata: { reason: "account_deleted" },
              ip,
              userAgent: ua,
            })
            return json(c, 403, {
              error: "Account is scheduled for deletion. Click the cancel link in your email to restore it.",
              account_deleted: true,
            })
          }
          // Suspended accounts: reject after password verify so we don't leak
          // suspension state to unauthenticated probes.
          if (current.suspended_at) {
            logEvent(db, {
              userId: current.id,
              event: "login.fail",
              metadata: { reason: "account_suspended" },
              ip,
              userAgent: ua,
            })
            return json(c, 403, {
              error: "Account has been suspended by the owner. Contact the instance owner to restore access.",
              account_suspended: true,
            })
          }

          if (current.totp_enabled) {
            logEvent(db, { userId: current.id, event: "login.mfa_required", ip, userAgent: ua })
            return json(c, 200, {
              mfa_required: true,
              mfa_token: await issueMfaChallenge(tx, secret, current.id),
            })
          }

          logEvent(db, { userId: current.id, event: "login.ok", ip, userAgent: ua })
          const sess = await issueSession(
            tx,
            {
              id: current.id,
              email: current.email,
              username: current.username,
              name: current.name,
              is_owner: current.is_owner,
            },
            secret,
            { ip, userAgent: ua },
          )
          return json(c, 200, {
            id: current.id,
            email: current.email,
            username: current.username,
            name: current.name,
            is_owner: current.is_owner,
            token: sess.token,
          })
        })
      }),
    ),

    post(
      "/login/mfa",
      api(async c => {
        const ip = clientIp(c.request)
        const ua = userAgent(c.request)
        const body = c.body as {
          mfa_token?: string
          mfaToken?: string
          code?: string
          backup_code?: string
          backupCode?: string
        }
        const mfaToken = body.mfa_token ?? body.mfaToken
        const code = body.code?.trim()
        const backupCode = (body.backup_code ?? body.backupCode)?.trim()
        if (!mfaToken) return json(c, 422, { error: "mfa_token required" })
        if (!code && !backupCode) return json(c, 422, { error: "code or backup_code required" })

        let payload: { kind?: string; uid?: number; jti?: string; exp?: number; iat?: number }
        try {
          payload = (await token.verify(mfaToken, secret)) as {
            kind?: string
            uid?: number
            jti?: string
            exp?: number
            iat?: number
          }
        } catch {
          return json(c, 401, { error: "Invalid or expired MFA challenge — start over" })
        }
        if (
          payload.kind !== "mfa" ||
          !Number.isSafeInteger(payload.uid) ||
          (payload.uid ?? 0) <= 0 ||
          typeof payload.jti !== "string" ||
          typeof payload.exp !== "number" ||
          !Number.isFinite(payload.exp) ||
          payload.exp <= Date.now() / 1000 ||
          typeof payload.iat !== "number" ||
          !Number.isFinite(payload.iat) ||
          payload.iat > Date.now() / 1000 + 60
        ) {
          return json(c, 401, { error: "Invalid MFA challenge" })
        }
        const uid = payload.uid!
        const jti = payload.jti

        const ipRate = await checkRate(db, `mfa:ip:${ip}`, 30, 900)
        if (!ipRate.ok) {
          return json(c, 429, { error: "Too many attempts.", retry_after: ipRate.retryAfterSeconds })
        }
        const userRate = await checkRate(db, `mfa:user:${uid}`, 6, 900)
        if (!userRate.ok) {
          logEvent(db, { userId: uid, event: "login.mfa_locked", ip, userAgent: ua })
          return json(c, 429, {
            error: "Too many MFA attempts. Try again later.",
            retry_after: userRate.retryAfterSeconds,
          })
        }

        return db.transaction(async tx => {
          const user = (await tx.one({ text: "SELECT * FROM users WHERE id = $1 FOR UPDATE", values: [uid] })) as
            | (UserRow & { deleted_at: string | null; suspended_at: string | null })
            | null
          // Checked before the code so a replayed challenge can't burn a
          // backup code; consumed only after the code verifies.
          if (!(await mfaChallengeOpen(tx, jti, uid))) {
            return json(c, 401, { error: "MFA challenge already used or expired — sign in again" })
          }

          // the challenge was issued on this team's host and completes there
          if (!user || Number(user.team_id) !== teamFor(c.request).team.id) {
            return json(c, 401, { error: "Invalid MFA challenge" })
          }
          if (!user.totp_enabled || !user.totp_secret) {
            return json(c, 401, { error: "MFA not enabled for this user" })
          }
          // The account can be scheduled for deletion or suspended between the
          // password step and this one; the challenge must not outlive that.
          if (user.deleted_at) {
            logEvent(db, {
              userId: user.id,
              event: "login.fail",
              metadata: { reason: "account_deleted" },
              ip,
              userAgent: ua,
            })
            return json(c, 403, {
              error: "Account is scheduled for deletion. Click the cancel link in your email to restore it.",
              account_deleted: true,
            })
          }
          if (user.suspended_at) {
            logEvent(db, {
              userId: user.id,
              event: "login.fail",
              metadata: { reason: "account_suspended" },
              ip,
              userAgent: ua,
            })
            return json(c, 403, {
              error: "Account has been suspended by the owner. Contact the instance owner to restore access.",
              account_suspended: true,
            })
          }

          let verified = false
          if (code) {
            verified = await claimTotp(tx, user.id, user.totp_secret, code)
          } else if (backupCode) {
            const stored = user.totp_backup_codes ? (JSON.parse(user.totp_backup_codes) as string[]) : []
            verified = await consumeBackupCode(tx, user.id, stored, backupCode)
            if (verified) {
              logEvent(db, { userId: user.id, event: "login.mfa_backup_used", ip, userAgent: ua })
            }
          }

          if (!verified) {
            logEvent(db, { userId: user.id, event: "login.mfa_fail", ip, userAgent: ua })
            return json(c, 401, { error: "Invalid or already used code. Wait for a new code." })
          }
          if (!(await consumeMfaChallenge(tx, jti))) {
            return json(c, 401, { error: "MFA challenge already used or expired — sign in again" })
          }

          logEvent(db, { userId: user.id, event: "login.ok", metadata: { mfa: true }, ip, userAgent: ua })
          const sess = await issueSession(
            tx,
            {
              id: user.id,
              email: user.email,
              username: user.username,
              name: user.name,
              is_owner: user.is_owner,
            },
            secret,
            { ip, userAgent: ua },
          )
          return json(c, 200, {
            id: user.id,
            email: user.email,
            username: user.username,
            name: user.name,
            is_owner: user.is_owner,
            token: sess.token,
          })
        })
      }),
    ),
  ]
}
