ALTER TABLE folders ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE folders ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_folders_kind ON folders(kind) WHERE kind <> 'standard';
CREATE INDEX idx_folders_public ON folders(is_public) WHERE is_public = TRUE;
