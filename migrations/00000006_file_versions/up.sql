ALTER TABLE files ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE file_versions (
  id SERIAL PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  mime TEXT NOT NULL,
  size BIGINT NOT NULL,
  storage_key TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (file_id, version)
);
CREATE INDEX idx_file_versions_file ON file_versions(file_id);
