import { createHash } from "node:crypto"
import { hash, token, verify } from "@atlas/auth"
import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { del, get, json, parseJson, pipeline, post, putHeader, stream } from "@atlas/server"
import { requireAuth } from "../auth/guard.ts"
import { fileAccess, isOwner } from "../permissions/index.ts"
import { decideInline } from "../security/inline.ts"
import { checkRate, clientIp } from "../security/ratelimit.ts"
import type { StorageHandle } from "../storage/index.ts"
import { fetchObject } from "../storage/index.ts"
import { teamFor } from "../teams/request.ts"
import { dispatchWebhook } from "../webhooks/dispatch.ts"

const APP_TOKEN_PREFIX = "stohr_pat_"
const MAX_EXPIRES_SECONDS = 30 * 24 * 60 * 60

const authId = (c: any) => (c.assigns.auth as { id: number }).id

/* Base58 alphabet — drops the visually-ambiguous 0/O/I/l so shared URLs
 * can be read aloud or copied from a screen without errors. */
const SHORT_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
// 58^12 ≈ 2^70. Tokens minted at the old length of 7 keep resolving — the
// lookup is by value, so nothing here needs to know how long a token is.
const SHORT_LEN = 12

// Unknown tokens are counted per IP, and an IP that has burned through its
// budget is turned away before the lookup. Counting alone would not do: a
// guesser could keep probing and tell hits from misses by the status code.
const MISS_MAX = 30
const MISS_WINDOW_SECONDS = 900

const shortToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(SHORT_LEN))
  let out = ""
  for (let i = 0; i < SHORT_LEN; i++) {
    out += SHORT_ALPHABET[bytes[i]! % SHORT_ALPHABET.length]
  }
  return out
}

const allocShareToken = async (db: Connection): Promise<string> => {
  // Collisions effectively never happen, but we retry on the
  // unique-constraint race just in case.
  for (let i = 0; i < 8; i++) {
    const candidate = shortToken()
    const taken = await db.one(
      from("shares")
        .where(q => q("token").equals(candidate))
        .select("id"),
    )
    if (!taken) return candidate
  }
  throw new Error("Could not allocate a unique share token after 8 tries")
}

export const sweepExpiredShares = async (db: Connection) => {
  try {
    await db.execute(
      from("shares")
        .where(q => q("expires_at").isNotNull())
        .where(q => q("expires_at").lessThan(raw("NOW()")))
        .del(),
    )
  } catch (err) {
    console.error("[shares] sweep failed:", err)
  }
}

const hashAppToken = (raw: string): string => createHash("sha256").update(raw).digest("hex")

const resolveViewerId = async (db: Connection, secret: string, header: string | null): Promise<number | null> => {
  if (!header?.startsWith("Bearer ")) return null
  const t = header.slice(7).trim()
  if (t.startsWith(APP_TOKEN_PREFIX)) {
    const app = (await db.one(
      from("apps")
        .where(q => q("token_hash").equals(hashAppToken(t)))
        .select("user_id"),
    )) as { user_id: number } | null
    return app?.user_id ?? null
  }
  try {
    const payload = (await token.verify(t, secret)) as { id?: number }
    return payload.id ?? null
  } catch {
    return null
  }
}

export const shareRoutes = (db: Connection, secret: string, store: StorageHandle) => {
  const guard = pipeline(requireAuth({ secret, db }))
  const authed = pipeline(requireAuth({ secret, db }), parseJson)

  // The expiry sweep is scheduled from src/server.ts alongside every other
  // background sweep. Registering it here made the process lifecycle a side
  // effect of building routes — invisible from the composition root, and
  // unstoppable from tests that only wanted the route table.

  return [
    get(
      "/shares",
      guard(async c => {
        const userId = authId(c)
        const rows = await db.all(
          from("shares")
            .join("files", raw("files.id = shares.file_id"))
            .where(q => q("shares.user_id").equals(userId))
            .where(q => q("files.deleted_at").isNull())
            .select(
              "shares.id",
              "shares.token",
              "shares.expires_at",
              "shares.created_at",
              "shares.burn_on_view",
              "shares.password_hash",
              "files.name",
              "files.size",
              "files.mime",
              "shares.file_id",
            )
            .orderBy("shares.created_at", "DESC"),
        )
        return json(
          c,
          200,
          rows.map((r: any) => ({
            id: r.id,
            token: r.token,
            expires_at: r.expires_at,
            created_at: r.created_at,
            burn_on_view: r.burn_on_view,
            password_required: !!r.password_hash,
            name: r.name,
            size: r.size,
            mime: r.mime,
            file_id: r.file_id,
          })),
        )
      }),
    ),

    post(
      "/shares",
      authed(async c => {
        const userId = authId(c)
        const body = c.body as {
          file_id?: number
          fileId?: number
          expires_in?: number
          expiresIn?: number
          password?: string
          burn_on_view?: boolean
          burnOnView?: boolean
        }
        const fileId = body.file_id ?? body.fileId
        const expiresIn = body.expires_in ?? body.expiresIn
        const burnOnView = body.burn_on_view ?? body.burnOnView ?? false
        const password = body.password?.trim() || null

        if (!fileId) return json(c, 422, { error: "file_id required" })
        if (!expiresIn || expiresIn <= 0) {
          return json(c, 422, { error: "expires_in is required and must be > 0 seconds" })
        }
        if (expiresIn > MAX_EXPIRES_SECONDS) {
          return json(c, 422, { error: `expires_in cannot exceed ${MAX_EXPIRES_SECONDS} seconds (30 days)` })
        }

        // Owner-level only, resolved through the permissions module: for a
        // personal file that is its user_id, for a space file a space admin.
        // Matching on user_id alone let a space folder's creator keep minting
        // links after being demoted or removed.
        const access = await fileAccess(db, userId, fileId)
        if (!access || !isOwner(access.role)) return json(c, 404, { error: "File not found" })
        const file = access.file

        const tok = await allocShareToken(db)
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
        const passwordHash = password ? await hash(password) : null

        const rows = (await db.execute(
          from("shares")
            .insert({
              file_id: fileId,
              user_id: userId,
              token: tok,
              expires_at: expiresAt,
              password_hash: passwordHash,
              burn_on_view: burnOnView,
            })
            .returning("id", "token", "expires_at", "burn_on_view", "created_at"),
        )) as Array<{ id: number; token: string; expires_at: string; burn_on_view: boolean; created_at: string }>

        dispatchWebhook(db, userId, "share.created", {
          event: "share.created",
          share_id: rows[0]!.id,
          token: rows[0]!.token,
          file_id: fileId,
          file_name: file.name,
          expires_at: rows[0]!.expires_at,
          burn_on_view: rows[0]!.burn_on_view,
          created_at: rows[0]!.created_at,
          user_id: userId,
        })

        return json(c, 201, {
          ...rows[0],
          password_required: !!passwordHash,
        })
      }),
    ),

    del(
      "/shares/:id",
      guard(async c => {
        const userId = authId(c)
        const id = Number(c.params.id)
        const row = await db.one(
          from("shares")
            .where(q => q("id").equals(id))
            .where(q => q("user_id").equals(userId)),
        )
        if (!row) return json(c, 404, { error: "Share not found" })

        await db.execute(
          from("shares")
            .where(q => q("id").equals(id))
            .del(),
        )
        return json(c, 200, { deleted: id })
      }),
    ),

    get("/s/:token", async c => {
      const tok = c.params.token
      const ip = clientIp(c.request)
      const missBucket = `share:miss:ip:${ip}`

      const blocked = await db.one({
        text: `
          SELECT 1 FROM rate_limits
           WHERE bucket = $1
             AND count > $2
             AND window_started_at > NOW() - ($3 || ' seconds')::interval
        `,
        values: [missBucket, MISS_MAX, String(MISS_WINDOW_SECONDS)],
      })
      if (blocked) return json(c, 429, { error: "Too many attempts" })

      const share = (await db.one({
        text: `
          SELECT s.id, s.file_id, s.user_id, s.expires_at, s.password_hash, s.burn_on_view, u.team_id
            FROM shares s
            JOIN users u ON u.id = s.user_id
           WHERE s.token = $1
           LIMIT 1
        `,
        values: [tok],
      })) as {
        id: number
        file_id: number
        user_id: number
        expires_at: string | null
        password_hash: string | null
        burn_on_view: boolean
        team_id: number
      } | null
      // A link only resolves on its owner's team host. Elsewhere it is a miss
      // like any unknown token, counted the same way, so another team's host
      // cannot be used to confirm a token exists.
      if (!share || Number(share.team_id) !== teamFor(c.request).team.id) {
        const miss = await checkRate(db, missBucket, MISS_MAX, MISS_WINDOW_SECONDS)
        if (!miss.ok) return json(c, 429, { error: "Too many attempts", retry_after: miss.retryAfterSeconds })
        return json(c, 404, { error: "Share not found" })
      }

      if (share.expires_at && new Date(share.expires_at).getTime() < Date.now()) {
        await db.execute(
          from("shares")
            .where(q => q("id").equals(share.id))
            .del(),
        )
        return json(c, 410, { error: "Share expired" })
      }

      const file = (await db.one(
        from("files")
          .where(q => q("id").equals(share.file_id))
          .where(q => q("deleted_at").isNull()),
      )) as {
        id: number
        name: string
        size: number
        mime: string
        storage_key: string
        scan_status: string
        created_at: string
      } | null
      if (!file) return json(c, 404, { error: "File missing" })
      // Same gate as /files/:id/download; a share link is still a download.
      if (file.scan_status === "infected") return json(c, 403, { error: "File failed malware scan" })

      const url = new URL(c.request.url)
      const isMeta = url.searchParams.get("meta") === "1"

      if (isMeta) {
        return json(c, 200, {
          name: file.name,
          size: file.size,
          mime: file.mime,
          created_at: file.created_at,
          expires_at: share.expires_at,
          password_required: !!share.password_hash,
          burn_on_view: share.burn_on_view,
        })
      }

      // Password gate (if set). Header only — query strings end up in browser
      // history, server access logs, and Referer, so we never accept the
      // password via ?p=.
      if (share.password_hash) {
        // Throttle wrong-password attempts before bcrypt-verify so a short
        // user-set password isn't trivially brute-forceable. Two buckets so
        // a single IP can't lock out other viewers, and a token-rotating
        // attacker still hits the per-share cap.
        const ipRate = await checkRate(db, `share:pw:ip:${ip}`, 30, 900)
        if (!ipRate.ok) {
          return json(c, 429, { error: "Too many attempts", retry_after: ipRate.retryAfterSeconds })
        }
        const tokRate = await checkRate(db, `share:pw:tok:${share.id}`, 10, 900)
        if (!tokRate.ok) {
          return json(c, 429, { error: "Too many attempts", retry_after: tokRate.retryAfterSeconds })
        }
        const provided = c.request.headers.get("x-share-password") ?? ""
        if (!provided || !(await verify(provided, share.password_hash))) {
          return json(c, 401, { error: "Password required", password_required: true })
        }
      }

      // Owner detection — owner can preview without burning.
      const viewerId = await resolveViewerId(db, secret, c.request.headers.get("authorization"))
      const isOwner = viewerId === share.user_id

      // Atomic claim if burn-on-view applies.
      if (share.burn_on_view && !isOwner) {
        const claimed = (await db.execute(
          from("shares")
            .where(q => q("id").equals(share.id))
            .del()
            .returning("id"),
        )) as Array<{ id: number }>
        if (claimed.length === 0) {
          return json(c, 404, { error: "Share consumed" })
        }
      }

      const res = await fetchObject(store, file.storage_key)
      if (!res.body) return json(c, 500, { error: "Storage returned empty body" })

      const wantInline = url.searchParams.get("inline") === "1"
      const { contentType, disposition } = decideInline(file.mime, file.name, wantInline)

      const withHeaders = putHeader(
        putHeader(putHeader(c, "content-type", contentType), "content-disposition", disposition),
        "content-length",
        String(file.size),
      )
      return stream(withHeaders, 200, res.body)
    }),
  ]
}
