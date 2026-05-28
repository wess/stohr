-- Full-text content search.
--
-- text_content holds the extracted plain-text body of each file (capped to
-- ~1 MB at insertion time to keep the row reasonable). text_tsv is a
-- generated tsvector so Postgres maintains the index without app-side
-- bookkeeping. text_indexed_version mirrors files.version at the moment of
-- the last successful extraction — when a user uploads a new version, the
-- indexer worker spots the gap and re-extracts.

ALTER TABLE files
  ADD COLUMN text_content TEXT,
  ADD COLUMN text_indexed_version INTEGER,
  ADD COLUMN text_indexed_at TIMESTAMPTZ,
  ADD COLUMN text_extract_error TEXT,
  ADD COLUMN text_tsv tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(text_content, '')), 'B')
    ) STORED;

CREATE INDEX files_text_tsv_idx ON files USING GIN (text_tsv);

-- Partial index for the indexer worker: rows that still need work. Once
-- every row is indexed against its current version this is mostly empty,
-- so it stays cheap to scan.
CREATE INDEX files_text_pending_idx
  ON files (id)
  WHERE deleted_at IS NULL
    AND (text_indexed_at IS NULL OR text_indexed_version IS NULL OR text_indexed_version < version);
