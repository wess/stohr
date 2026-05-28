DROP INDEX IF EXISTS files_text_pending_idx;
DROP INDEX IF EXISTS files_text_tsv_idx;
ALTER TABLE files
  DROP COLUMN IF EXISTS text_tsv,
  DROP COLUMN IF EXISTS text_extract_error,
  DROP COLUMN IF EXISTS text_indexed_at,
  DROP COLUMN IF EXISTS text_indexed_version,
  DROP COLUMN IF EXISTS text_content;
