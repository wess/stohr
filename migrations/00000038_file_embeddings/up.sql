-- pgvector — most managed Postgres providers (Supabase, Neon, RDS,
-- DigitalOcean, Crunchy) ship this extension. If your provider doesn't
-- have it, AI features must be left disabled (AI_EMBED_MODEL unset).
CREATE EXTENSION IF NOT EXISTS vector;

-- Locked at dim=768 for v1 — matches the default model
-- nomic-embed-text-v1.5. Switching to a smaller embedder (bge-small,
-- dim=384) requires a fresh table; we don't try to be flexible here
-- because pgvector's HNSW index needs a fixed dim at index creation.
CREATE TABLE file_embeddings (
  file_id BIGINT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,

  -- Sha256 of the extracted text. Lets the job runner skip rows whose
  -- content hasn't changed since the last embedding pass — uploads of
  -- new versions with identical text are no-ops.
  content_hash TEXT NOT NULL,

  -- First ~1KB of extracted text. Returned in semantic-search responses
  -- so the SPA can render a snippet without re-fetching the file.
  text_excerpt TEXT,

  embedding vector(768) NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW + cosine ops — fast ANN with sub-50ms queries on millions of
-- vectors. The index is heavier on writes than ivfflat but worth it
-- for read latency.
CREATE INDEX idx_file_embeddings_hnsw
  ON file_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_file_embeddings_model ON file_embeddings(model);
