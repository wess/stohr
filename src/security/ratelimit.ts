import type { Connection } from "@atlas/db"

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
  const rows = await db.execute({ text, values: [bucket, String(windowSeconds)] }) as Array<{
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

export const clientIp = (req: Request): string => {
  const fwd = req.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0]?.trim() || "unknown"
  const real = req.headers.get("x-real-ip")
  if (real) return real
  return "unknown"
}

export const userAgent = (req: Request): string =>
  (req.headers.get("user-agent") ?? "").slice(0, 256)
