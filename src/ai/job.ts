import type { Connection } from "@atlas/db"
import { from, raw } from "@atlas/db"
import type { StorageHandle } from "../storage/index.ts"
import { fetchObject } from "../storage/index.ts"
import { excerpt, extractText, isEmbeddableMime, sha256Hex } from "./extract.ts"
import { embedText, isAiEnabled, aiModelId } from "./index.ts"
import { log } from "../log/index.ts"

// Job runner handler for "embeddings.generate". Idempotent and
// best-effort: a deleted/changed file by the time the job runs is a
// no-op, not a failure. Throws only when AI is enabled and the embed
// call itself crashes — so the job runner retries with backoff.

const MAX_BYTES = 5 * 1024 * 1024 // 5MB cap on what we'll embed

type FileRow = {
  id: number
  name: string
  mime: string
  size: number | string
  storage_key: string
  user_id: number
  deleted_at: string | null
}

export const handleEmbeddingsGenerate = async (
  db: Connection,
  store: StorageHandle,
  payload: { file_id: number },
): Promise<void> => {
  if (!isAiEnabled()) return // disabled — silently skip
  const modelId = aiModelId()
  if (!modelId) return

  const file = await db.one(
    from("files").where(q => q("id").equals(payload.file_id)),
  ) as FileRow | null

  if (!file || file.deleted_at) return
  if (!isEmbeddableMime(file.mime)) return

  const size = Number(file.size)
  if (size <= 0 || size > MAX_BYTES) return

  const res = await fetchObject(store, file.storage_key)
  if (!res.body) return

  const buf = new Uint8Array(await res.arrayBuffer())
  const text = await extractText(buf, file.mime, file.name)
  if (!text) return

  const hash = await sha256Hex(text)

  // Skip if we already embedded this exact content with this model.
  const existing = await db.one(
    from("file_embeddings")
      .where(q => q("file_id").equals(file.id))
      .select("content_hash", "model"),
  ) as { content_hash: string; model: string } | null
  if (existing && existing.content_hash === hash && existing.model === modelId) {
    return
  }

  const vec = embedText(text)
  if (!vec) {
    throw new Error("embed returned null — bai disabled mid-flight?")
  }

  // pgvector accepts a string literal; format with 6 decimals to stay
  // within float32 precision while keeping the row compact.
  let lit = "["
  for (let i = 0; i < vec.length; i++) {
    if (i > 0) lit += ","
    lit += (vec[i] as number).toFixed(6)
  }
  lit += "]"

  // Upsert. Ownership of (file_id) makes ON CONFLICT trivial.
  await db.execute({
    text: `
      INSERT INTO file_embeddings (file_id, content_hash, text_excerpt, embedding, model, updated_at)
      VALUES ($1, $2, $3, $4::vector, $5, NOW())
      ON CONFLICT (file_id) DO UPDATE SET
        content_hash = EXCLUDED.content_hash,
        text_excerpt = EXCLUDED.text_excerpt,
        embedding = EXCLUDED.embedding,
        model = EXCLUDED.model,
        updated_at = NOW()
    `,
    values: [file.id, hash, excerpt(text), lit, modelId],
  })

  log.debug("file embedded", { file_id: file.id, model: modelId, bytes: buf.length, chars: text.length })
}

// Convenience for the file-lifecycle hooks. Keep enqueue silent when AI
// is disabled — no point queuing jobs that will all be skipped.
export const enqueueIfEnabled = async (
  db: Connection,
  fileId: number,
): Promise<void> => {
  if (!isAiEnabled()) return
  await db.execute(
    from("jobs").insert({
      type: "embeddings.generate",
      payload: JSON.stringify({ file_id: fileId }),
      run_at: raw("NOW()"),
      max_attempts: 3,
    }),
  )
}
