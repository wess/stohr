import { randomBytes } from "node:crypto"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { json, pipeline, post } from "@atlas/server"
import type { Emailer } from "../email/index.ts"
import { accountDeletionEmail } from "../email/templates/deletion.ts"
import { logEvent } from "../security/audit.ts"
import { checkRate, clientIp, userAgent } from "../security/ratelimit.ts"
import { issueSession } from "../security/sessions.ts"
import type { StorageHandle } from "../storage/index.ts"
import { drop } from "../storage/index.ts"
import { teamFor } from "../teams/request.ts"
import { purgeUserUploads } from "../uploads/index.ts"
import { parseJson } from "../util/json/index.ts"
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
 * Hard-delete one user, keeping Space content with surviving members.
 * Personal and abandoned-Space rows go before their blobs. Storage failures
 * are tolerated after the transaction commits. Also used by the team sweep.
 */
export const purgeUser = async (db: Connection, store: StorageHandle, id: number): Promise<void> => {
  // staged multipart bytes aren't reachable once the session rows cascade away
  await purgeUserUploads(db, store, id)
  const { fileKeys, versionKeys } = await db.transaction(async tx => {
    const spaces = (await tx.execute({
      text: "SELECT id FROM spaces WHERE owner_id = $1 FOR UPDATE",
      values: [id],
    })) as Array<{ id: number }>
    const abandoned: number[] = []
    for (const space of spaces) {
      const next = (await tx.one({
        text: `SELECT m.user_id FROM space_members m JOIN users u ON u.id = m.user_id
          WHERE m.space_id = $1 AND m.user_id <> $2 AND u.deleted_at IS NULL
            AND u.suspended_at IS NULL
            AND u.team_id = (SELECT team_id FROM users WHERE id = $2)
          ORDER BY CASE m.role WHEN 'admin' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.id
          LIMIT 1`,
        values: [space.id, id],
      })) as { user_id: number } | null
      if (!next) {
        abandoned.push(space.id)
        continue
      }
      await tx.execute(
        from("spaces")
          .where(q => q("id").equals(space.id))
          .update({ owner_id: next.user_id }),
      )
      await tx.execute(
        from("space_members")
          .where(q => q("space_id").equals(space.id))
          .where(q => q("user_id").equals(next.user_id))
          .update({ role: "admin" }),
      )
    }

    // attribution must not let an account deletion cascade through a team's tree
    await tx.execute({
      text: `UPDATE files f SET user_id = s.owner_id FROM folders fo JOIN spaces s ON s.id = fo.space_id
        WHERE f.folder_id = fo.id AND f.user_id = $1 AND s.owner_id <> $1`,
      values: [id],
    })
    await tx.execute({
      text: `UPDATE folders fo SET user_id = s.owner_id FROM spaces s
        WHERE fo.space_id = s.id AND fo.user_id = $1 AND s.owner_id <> $1`,
      values: [id],
    })
    const fileKeys = (await tx.execute({
      text: `SELECT f.storage_key, f.thumb_key FROM files f LEFT JOIN folders fo ON fo.id = f.folder_id
        WHERE f.user_id = $1 OR fo.space_id = ANY($2::int[])`,
      values: [id, `{${abandoned.join(",")}}`],
    })) as Array<{ storage_key: string; thumb_key: string | null }>
    const versionKeys = (await tx.execute({
      text: `SELECT v.storage_key FROM file_versions v JOIN files f ON f.id = v.file_id
        LEFT JOIN folders fo ON fo.id = f.folder_id
        WHERE f.user_id = $1 OR fo.space_id = ANY($2::int[])`,
      values: [id, `{${abandoned.join(",")}}`],
    })) as Array<{ storage_key: string }>
    if (abandoned.length)
      await tx.execute(
        from("spaces")
          .where(q => q("id").inList(abandoned))
          .del(),
      )
    await tx.execute(
      from("users")
        .where(q => q("id").equals(id))
        .del(),
    )
    return { fileKeys, versionKeys }
  })

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
