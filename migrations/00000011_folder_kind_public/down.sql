DROP INDEX IF EXISTS idx_folders_public;
DROP INDEX IF EXISTS idx_folders_kind;
ALTER TABLE folders DROP COLUMN IF EXISTS is_public;
ALTER TABLE folders DROP COLUMN IF EXISTS kind;
