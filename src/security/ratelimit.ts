import type { Connection } from "@atlas/db"
import { forwardedClientIp, isTrustedProxy, normalizeIp } from "./proxies.ts"

export type RateLimitResult = {
  ok: boolean
  count: number
  retryAfterSeconds: number
}

export const checkRate = async (
  db: Connection,
  bucket: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> => {
  // Atomic UPSERT: insert with count=1 OR update by either resetting (window
  // expired) or incrementing. Returns the resulting count + window start so we
  // can compute retry-after for blocked callers.
  const text = `
    INSERT INTO rate_limits (bucket, count, window_started_at)
    VALUES ($1, 1, NOW())
    ON CONFLICT (bucket) DO UPDATE SET
      count = CASE
        WHEN rate_limits.window_started_at < NOW() - ($2 || ' seconds')::interval THEN 1
        ELSE rate_limits.count + 1
      END,
      window_started_at = CASE
        WHEN rate_limits.window_started_at < NOW() - ($2 || ' seconds')::interval THEN NOW()
        ELSE rate_limits.window_started_at
      END
    RETURNING count, EXTRACT(EPOCH FROM window_started_at)::bigint AS started
  `
  const rows = (await db.execute({ text, values: [bucket, String(windowSeconds)] })) as Array<{
    count: number
    started: number | string | bigint
  }>
  const row = rows[0]
  const count = Number(row?.count ?? 0)
  if (count <= max) {
    return { ok: true, count, retryAfterSeconds: 0 }
  }
  // Postgres' EXTRACT(EPOCH FROM ...)::bigint rounds rather than floors, so the
  // returned start can be a tick ahead of Date.now()/1000. Clamp the result.
  const startedSec = Number(row?.started ?? 0)
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - startedSec)
  const retryAfter = Math.min(windowSeconds, Math.max(1, windowSeconds - elapsed))
  return { ok: false, count, retryAfterSeconds: retryAfter }
}

// Buckets are keyed on caller-supplied values — `login:id:<whatever>`,
// `contact:email:<whatever>` — so an unauthenticated caller can mint an
// unbounded number of rows just by varying the identity it submits. Nothing
// in the UPSERT above ever deletes, so the table only grows. Drop buckets
// whose window closed long ago; the longest window in use is an hour, and a
// day of slack keeps this well clear of any in-flight limit.
const RATE_LIMIT_RETENTION_HOURS = 24

export const sweepRateLimits = async (db: Connection): Promise<void> => {
  await db.execute({
    text: `DELETE FROM rate_limits WHERE window_started_at < NOW() - ($1 || ' hours')::interval`,
    values: [String(RATE_LIMIT_RETENTION_HOURS)],
  })
}

// withSecurityHeaders stashes the Bun.serve socket peer onto the request as
// `req.peerIp`. We fall back to "unknown" when it isn't set (e.g. tests).
const peerIp = (req: Request): string => (req as { peerIp?: string }).peerIp ?? "unknown"

export const clientIp = (req: Request): string => {
  const peer = normalizeIp(peerIp(req))
  // Only honor X-Forwarded-For / X-Real-IP when the request actually arrived
  // from a configured trusted proxy. Otherwise the header is attacker-supplied
  // and we'd be letting a remote client pin or spoof rate-limit buckets.
  if (!isTrustedProxy(peer)) return peer
  // Even behind a trusted proxy the left-most entry is client-supplied; the
  // walk from the right stops at the first hop we don't trust.
  const fwd = forwardedClientIp(req.headers.get("x-forwarded-for"))
  if (fwd) return fwd
  const real = req.headers.get("x-real-ip")?.trim()
  return real ? normalizeIp(real) : peer
}

export const userAgent = (req: Request): string => (req.headers.get("user-agent") ?? "").slice(0, 256)
