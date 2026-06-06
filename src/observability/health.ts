// Liveness and readiness endpoints. Both are public and unauthenticated —
// orchestrators (Docker healthcheck, Kubernetes probes, load balancers) hit
// them before any credential exists, so they must never require auth.
//
//   GET /healthz  — liveness. The process is up and the event loop is turning.
//                   No dependency checks; never touches Postgres or storage.
//                   Always 200 {status:"alive"}.
//   GET /readyz   — readiness. Verifies the dependencies a request actually
//                   needs: Postgres (SELECT 1) and the blob backend (probe).
//                   200 {status:"ready",checks:{…}} when all pass, else 503.

import type { Connection } from "@atlas/db"
import { get, json } from "@atlas/server"
import type { StorageHandle } from "../storage/index.ts"

const checkDb = async (db: Connection): Promise<boolean> => {
  try {
    await db.one({ text: "SELECT 1", values: [] })
    return true
  } catch {
    return false
  }
}

// We can't HEAD the bucket through the StorageDriver interface (it only exposes
// put/get/drop — by design, no presign/admin surface). So we probe with a get
// on a key that won't exist. A reachable backend answers with "not found",
// which both drivers signal by throwing; an unreachable backend (DNS, refused
// connection, bad credentials) throws too — so we distinguish on the message.
// A "not found" / 404 means the backend responded: ready. Anything else: not.
const NOT_FOUND_RE = /not found|404|nosuchkey|no such key|enoent/i
const PROBE_KEY = "__stohr_healthz_probe__"

const checkStorage = async (store: StorageHandle): Promise<boolean> => {
  try {
    await store.get(PROBE_KEY)
    // The key shouldn't exist, but if it somehow resolves the backend is up.
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NOT_FOUND_RE.test(msg)
  }
}

export const healthRoutes = (db: Connection, store: StorageHandle) => [
  get("/healthz", async c => json(c, 200, { status: "alive" })),

  get("/readyz", async c => {
    const [database, storage] = await Promise.all([checkDb(db), checkStorage(store)])
    const ready = database && storage
    return json(c, ready ? 200 : 503, {
      status: ready ? "ready" : "not_ready",
      checks: { database, storage },
    })
  }),
]
