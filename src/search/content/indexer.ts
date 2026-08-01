import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import { fetchObject, type StorageHandle } from "../../storage/index.ts"
import { extractText, MAX_TEXT_BYTES } from "./extract.ts"

// Skip extraction entirely for blobs over this size — they're almost
// certainly media files where the extractors would either fail or burn
// CPU to no benefit.
const SIZE_CEILING = 50 * 1024 * 1024

type Pending = {
  id: number
  user_id: number
  storage_key: string
  name: string
  mime: string
  size: number | string
  version: number
}

const fetchBytes = async (store: StorageHandle, key: string, maxBytes: number): Promise<Uint8Array> => {
  const res = await fetchObject(store, key)
  if (!res.ok) throw new Error(`Storage read failed for ${key}: ${res.status}`)
  // Stream-read so we can stop early once we have enough for extraction +
  // a little headroom. Office files compress 5–10x, so for natively-
  // searchable formats we fetch up to MAX_TEXT_BYTES * 8 worth of bytes.
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array(await res.arrayBuffer())
  const chunks: Uint8Array[] = []
  let read = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      read += value.byteLength
      if (read >= maxBytes) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  }
  const out = new Uint8Array(read)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

const claim = async (db: Connection, batchSize: number): Promise<Pending[]> => {
  // Pure SELECT — the conditional update at the end of indexOne is the
  // marker that prevents two workers from re-indexing the same row.
  // Sufficient at our scale (single API process per host); we can layer in
  // SKIP LOCKED if we ever shard the worker.
  const rows = (await db.execute({
    text: `
      SELECT id, user_id, storage_key, name, mime, size, version
        FROM files
       WHERE deleted_at IS NULL
         AND (text_indexed_at IS NULL OR text_indexed_version IS NULL OR text_indexed_version < version)
       ORDER BY id ASC
       LIMIT $1
    `,
    values: [batchSize],
  })) as Pending[]
  return rows
}

const recordExtraction = async (
  db: Connection,
  fileId: number,
  version: number,
  result: { text: string | null; error: string | null },
) => {
  await db.execute(
    from("files")
      .where(q => q("id").equals(fileId))
      .where(q => q("version").equals(version))
      .update({
        text_content: result.text,
        text_extract_error: result.error,
        text_indexed_version: version,
        text_indexed_at: raw("NOW()"),
      }),
  )
}

const indexOne = async (db: Connection, store: StorageHandle, row: Pending): Promise<void> => {
  const size = typeof row.size === "string" ? Number(row.size) : row.size
  if (!Number.isFinite(size) || size > SIZE_CEILING) {
    await recordExtraction(db, row.id, row.version, { text: null, error: "skipped: oversize" })
    return
  }

  let bytes: Uint8Array
  try {
    bytes = await fetchBytes(store, row.storage_key, MAX_TEXT_BYTES * 8)
  } catch (err) {
    await recordExtraction(db, row.id, row.version, { text: null, error: (err as Error).message })
    return
  }

  let result: Awaited<ReturnType<typeof extractText>>
  try {
    result = await extractText(bytes, { mime: row.mime, name: row.name })
  } catch (err) {
    await recordExtraction(db, row.id, row.version, { text: null, error: (err as Error).message })
    return
  }

  if (result.kind === "text") {
    await recordExtraction(db, row.id, row.version, { text: result.text, error: null })
  } else if (result.kind === "skip") {
    await recordExtraction(db, row.id, row.version, { text: null, error: `skipped: ${result.reason}` })
  } else {
    await recordExtraction(db, row.id, row.version, { text: null, error: result.reason })
  }
}

export const indexBatch = async (db: Connection, store: StorageHandle, batchSize = 5): Promise<number> => {
  const pending = await claim(db, batchSize)
  for (const row of pending) {
    try {
      await indexOne(db, store, row)
    } catch (err) {
      console.error(`[content-index] file ${row.id} failed:`, err)
    }
  }
  return pending.length
}
