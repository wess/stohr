import { randomBytes } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { json, parseJson, pipeline, post } from "@atlas/server"
import type { Emailer } from "../email/index.ts"
import { accountDeletionEmail } from "../email/templates/deletion.ts"
import { logEvent } from "../security/audit.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import { issueSession } from "../security/sessions.ts"
import type { StorageHandle } from "../storage/index.ts"
import { drop } from "../storage/index.ts"
import { teamFor } from "../teams/request.ts"
import { purgeUserUploads } from "../uploads/index.ts"
import { hashToken } from "./guard.ts"

export const ACCOUNT_DELETION_PREFIX = "stohr_acd_"
const GRACE_HOURS = 24

const generateCancelToken = (): string => `${ACCOUNT_DELETION_PREFIX}${randomBytes(32).toString("base64url")}`

/**
 * Schedule a soft-delete + email the user a cancel link. Called by the
 * `DELETE /me` handler after it has password-verified the request.
 *
 * `baseUrl` is the host the user's team lives on (requestBaseUrl): the
 * restore route only honours the token on that host.
 *
 * Returns true if scheduling succeeded — caller decides what to send back to
 * the client. Idempotent: if the user is already pending deletion, the same
 * token is reused (we have no way to know the plaintext we sent earlier, so
 * we generate a fresh one and overwrite the hash; the previously-emailed
 * link goes dead — acceptable trade-off).
 */
export const scheduleDeletion = async (
  db: Connection,
  emailer: Emailer,
  baseUrl: string,
  user: { id: number; email: string; name: string },
  ctx: { ip: string; userAgent: string },
): Promise<{ token: string }> => {
  const cancelToken = generateCancelToken()
  const tokenHash = hashToken(cancelToken)

  await db.execute(
    from("users")
      .where(q => q("id").equals(user.id))
      .update({ deleted_at: raw("NOW()"), deletion_token_hash: tokenHash }),
  )

  const cancelUrl = `${baseUrl.replace(/\/$/, "")}/account/restore?token=${encodeURIComponent(cancelToken)}`
  const tpl = accountDeletionEmail({ name: user.name, cancelUrl })
  const sent = await emailer.send({
    to: user.email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  })

  logEvent(db, {
    userId: user.id,
    event: "account.deletion_scheduled",
    metadata: { email_ok: sent.ok, grace_hours: GRACE_HOURS, error: sent.ok ? null : sent.error },
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  })

  return { token: cancelToken }
}

export const deletionRoutes = (db: Connection, secret: string) => {
  const open = pipeline(parseJson)

  return [
    post(
      "/account/restore",
      open(async c => {
        const ip = clientIp(c.request)
        const ua = userAgent(c.request)
        const body = c.body as { token?: string }
        const tokenRaw = body.token?.trim() ?? ""

        if (!tokenRaw?.startsWith(ACCOUNT_DELETION_PREFIX)) {
          return json(c, 400, { error: "Invalid or expired cancel link" })
        }

        const ipRate = await checkRate(db, `acd:restore:ip:${ip}`, 30, 900)
        if (!ipRate.ok) {
          return json(c, 429, { error: "Too many attempts. Try again later.", retry_after: ipRate.retryAfterSeconds })
        }

        // a cancel link works on the account's own team host only, like
        // every other credential
        const tokenHash = hashToken(tokenRaw)
        const user = (await db.one(
          from("users")
            .where(q => q("deletion_token_hash").equals(tokenHash))
            .where(q => q("team_id").equals(teamFor(c.request).team.id))
            .select("id", "email", "username", "name", "is_owner", "deleted_at"),
        )) as {
          id: number
          email: string
          username: string
          name: string
          is_owner: boolean
          deleted_at: string | null
        } | null

        if (!user?.deleted_at) {
          return json(c, 400, { error: "Invalid or expired cancel link" })
        }
        // Defense-in-depth: even if the sweeper hasn't run, refuse to restore an
        // account whose grace window has already passed.
        const graceMs = GRACE_HOURS * 60 * 60 * 1000
        if (new Date(user.deleted_at).getTime() + graceMs < Date.now()) {
          return json(c, 410, {
            error:
              "The cancel window has elapsed. The account is already permanently deleted (or will be on the next sweep).",
          })
        }

        await db.execute(
          from("users")
            .where(q => q("id").equals(user.id))
            .update({ deleted_at: null, deletion_token_hash: null }),
        )

        // Restoring is identity-confirming — issue a new session so the user is
        // signed straight back in from the email link click.
        const sess = await issueSession(
          db,
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

        logEvent(db, {
          userId: user.id,
          event: "account.deletion_canceled",
          ip,
          userAgent: ua,
        })

        return json(c, 200, {
          ok: true,
          token: sess.token,
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            name: user.name,
            is_owner: user.is_owner,
          },
        })
      }),
    ),
  ]
}

/**
 * Hard-delete one user: the row goes first (every FK cascades — files,
 * folders, shares, file_versions, sessions, ...), then the blobs that
 * belonged to it are dropped. Storage failures are tolerated; the rows are
 * already gone. Also used by the team purge sweep.
 */
export const purgeUser = async (db: Connection, store: StorageHandle, id: number): Promise<void> => {
  const fileKeys = (await db.all(
    from("files")
      .where(q => q("user_id").equals(id))
      .select("storage_key", "thumb_key"),
  )) as Array<{ storage_key: string; thumb_key: string | null }>
  const versionKeys = (await db.all(
    from("file_versions")
      .join("files", raw("files.id = file_versions.file_id"))
      .where(q => q("files.user_id").equals(id))
      .select("file_versions.storage_key"),
  )) as unknown as Array<{ storage_key: string }>

  // staged multipart bytes aren't reachable once the session rows cascade away
  await purgeUserUploads(db, store, id)

  await db.execute(
    from("users")
      .where(q => q("id").equals(id))
      .del(),
  )

  const drops: Array<Promise<unknown>> = []
  for (const f of fileKeys) {
    drops.push(drop(store, f.storage_key))
    if (f.thumb_key) drops.push(drop(store, f.thumb_key))
  }
  for (const v of versionKeys) drops.push(drop(store, v.storage_key))
  await Promise.allSettled(drops)
}

/**
 * Hard-delete users whose grace window has elapsed. Each user is purged in
 * its own try/catch so a single failure doesn't poison the whole sweep.
 */
export const sweepDeletedAccounts = async (db: Connection, store: StorageHandle): Promise<void> => {
  const expired = (await db.all(
    from("users")
      .where(q => q("deleted_at").isNotNull())
      .where(q => q("deleted_at").lessThan(raw(`NOW() - INTERVAL '${GRACE_HOURS} hours'`)))
      .select("id"),
  )) as Array<{ id: number }>

  for (const { id } of expired) {
    try {
      await purgeUser(db, store, id)
    } catch (err) {
      console.error(`[deletion] sweep failed for user ${id}:`, err)
    }
  }
}
