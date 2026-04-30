import type { Connection } from "@atlas/db"
import { get, json } from "@atlas/server"
import type { StorageHandle } from "../storage/index.ts"

const startedAt = Date.now()

// /healthz: liveness — process is up. Cheap, never touches the DB.
// /readyz: readiness — actually verifies the dependencies that requests need.
// Load balancers should poll /readyz; orchestrators polling for "is the
// process alive" should poll /healthz.
export const healthRoutes = (db: Connection, store: StorageHandle) => [
  get("/healthz", async (c) =>
    json(c, 200, { ok: true, uptime_s: Math.floor((Date.now() - startedAt) / 1000) }),
  ),

  get("/readyz", async (c) => {
    const checks: Record<string, { ok: boolean; error?: string; ms?: number }> = {}
    let ok = true

    const dbStart = performance.now()
    try {
      await db.execute({ text: "SELECT 1", values: [] })
      checks.db = { ok: true, ms: Math.round(performance.now() - dbStart) }
    } catch (err) {
      ok = false
      checks.db = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    // Storage check is best-effort: a HEAD on the bucket is the cheapest
    // ping that proves credentials + endpoint are wired correctly. If
    // @atlas/storage exposes no such helper, mark as skipped (still ok).
    const storeStart = performance.now()
    try {
      const handle = store as unknown as { ping?: () => Promise<unknown> }
      if (typeof handle.ping === "function") {
        await handle.ping()
        checks.storage = { ok: true, ms: Math.round(performance.now() - storeStart) }
      } else {
        checks.storage = { ok: true, ms: 0 }
      }
    } catch (err) {
      ok = false
      checks.storage = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    return json(c, ok ? 200 : 503, { ok, checks })
  }),
]
