CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_files_name_trgm
  ON files USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_folders_name_trgm
  ON folders USING GIN (name gin_trgm_ops);
