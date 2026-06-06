import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { fetchObject, type StorageHandle } from "../storage/index.ts"
import { scanBytes } from "./clamd.ts"

// AV scanning is opt-in: it only does anything when CLAMD_HOST is set. When
// unset, uploads are marked 'skipped' and never gated, so existing
// deployments are unaffected. See src/server.ts for the env wiring.

export type ScanStatus = "pending" | "clean" | "infected" | "error" | "skipped"

export type ClamdConfig = { host: string; port: number }

// clamd's StreamMaxLength default is 25 MB. Files larger than this can't be
// streamed in one INSTREAM session, so we mark them skipped rather than
// erroring forever in the sweep.
const MAX_SCAN_BYTES = 25 * 1024 * 1024

type ScanRow = {
  id: number
  storage_key: string
  size: number | string
}

// Read the configured clamd endpoint from the environment. Returns null when
// CLAMD_HOST is unset/blank — that's the signal that scanning is disabled.
export const clamdConfig = (): ClamdConfig | null => {
  const host = (process.env.CLAMD_HOST ?? "").trim()
  if (!host) return null
  const port = Number(process.env.CLAMD_PORT ?? "3310")
  return { host, port: Number.isFinite(port) ? port : 3310 }
}

const fetchAllBytes = async (store: StorageHandle, key: string): Promise<Uint8Array> => {
  const res = await fetchObject(store, key)
  if (!res.ok) throw new Error(`Storage read failed for ${key}: ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

const recordStatus = async (db: Connection, fileId: number, status: ScanStatus, signature: string | null) => {
  await db.execute(
    from("files")
      .where(q => q("id").equals(fileId))
      .update({
        scan_status: status,
        scan_signature: signature,
        scanned_at: raw("NOW()"),
      }),
  )
}

// Scan a single file row's current blob and persist the verdict. Safe to call
// when clamd is unconfigured — it records 'skipped' and returns. Never throws
// for operational failures; transient errors are recorded as 'error' so the
// sweep can retry later.
export const scanFileRow = async (
  db: Connection,
  store: StorageHandle,
  fileRow: { id: number; storage_key: string; size: number | string },
): Promise<ScanStatus> => {
  const cfg = clamdConfig()
  if (!cfg) {
    await recordStatus(db, fileRow.id, "skipped", null)
    return "skipped"
  }

  const size = typeof fileRow.size === "string" ? Number(fileRow.size) : fileRow.size
  if (Number.isFinite(size) && size > MAX_SCAN_BYTES) {
    await recordStatus(db, fileRow.id, "skipped", null)
    return "skipped"
  }

  let bytes: Uint8Array
  try {
    bytes = await fetchAllBytes(store, fileRow.storage_key)
  } catch (err) {
    console.error(`[av-scan] fetch failed for file ${fileRow.id}:`, err)
    await recordStatus(db, fileRow.id, "error", null)
    return "error"
  }

  try {
    const result = await scanBytes(cfg.host, cfg.port, bytes)
    if (result.clean) {
      await recordStatus(db, fileRow.id, "clean", null)
      return "clean"
    }
    await recordStatus(db, fileRow.id, "infected", result.signature)
    return "infected"
  } catch (err) {
    console.error(`[av-scan] clamd error for file ${fileRow.id}:`, err)
    await recordStatus(db, fileRow.id, "error", null)
    return "error"
  }
}

// Background sweep: scan every file still marked 'pending'. Registered on a
// setInterval in server.ts. No-ops when clamd is unconfigured (there should be
// no pending rows in that case, but we bail early regardless).
export const sweepPendingScans = async (db: Connection, store: StorageHandle, batchSize = 5): Promise<number> => {
  const cfg = clamdConfig()
  if (!cfg) return 0

  const rows = (await db.execute({
    text: `
      SELECT id, storage_key, size
        FROM files
       WHERE deleted_at IS NULL
         AND scan_status = 'pending'
       ORDER BY id ASC
       LIMIT $1
    `,
    values: [batchSize],
  })) as ScanRow[]

  for (const row of rows) {
    try {
      await scanFileRow(db, store, row)
    } catch (err) {
      console.error(`[av-scan] sweep failed for file ${row.id}:`, err)
    }
  }
  return rows.length
}
