import type { Connection } from "@atlas/db"

// pgvector ANN search. We pass the query vector as a stringified
// "[1.0, 2.0, ...]" literal — pgvector accepts both that and the binary
// format, and the literal form keeps the parameter binding plain text
// without depending on a custom node-postgres type.
//
// Visibility filter: limited to files the user owns. Collab-shared
// embeddings are out of scope for v1 — extending later would join
// against the collaborations table.

export type SemanticHit = {
  file_id: number
  name: string
  mime: string
  size: number
  folder_id: number | null
  text_excerpt: string | null
  score: number
}

const vectorLiteral = (v: Float32Array): string => {
  // pgvector accepts text input like "[0.123,0.456,...]"
  // (no spaces required). Use 6 decimal places — float32 has ~7
  // significant digits, so 6 stays lossless and keeps the literal small.
  let out = "["
  for (let i = 0; i < v.length; i++) {
    if (i > 0) out += ","
    out += (v[i] as number).toFixed(6)
  }
  out += "]"
  return out
}

export const semanticSearch = async (
  db: Connection,
  ownerId: number,
  embedding: Float32Array,
  limit: number,
): Promise<SemanticHit[]> => {
  const lit = vectorLiteral(embedding)
  // Cosine distance: 0 (identical) to 2 (opposite). Convert to a
  // 0..1 similarity score so the API returns something users can
  // reason about ("higher = more similar").
  const text = `
    SELECT
      f.id AS file_id,
      f.name,
      f.mime,
      f.size,
      f.folder_id,
      e.text_excerpt,
      1 - (e.embedding <=> $1::vector) AS score
    FROM file_embeddings e
    JOIN files f ON f.id = e.file_id
    WHERE f.user_id = $2 AND f.deleted_at IS NULL
    ORDER BY e.embedding <=> $1::vector
    LIMIT $3
  `
  const rows = await db.execute({ text, values: [lit, ownerId, limit] }) as Array<{
    file_id: number | string
    name: string
    mime: string
    size: number | string
    folder_id: number | null
    text_excerpt: string | null
    score: number | string
  }>
  return rows.map(r => ({
    file_id: Number(r.file_id),
    name: r.name,
    mime: r.mime,
    size: Number(r.size),
    folder_id: r.folder_id,
    text_excerpt: r.text_excerpt,
    score: Number(r.score),
  }))
}
