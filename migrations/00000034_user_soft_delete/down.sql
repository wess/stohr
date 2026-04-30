DROP INDEX IF EXISTS idx_users_deletion_token_hash;
DROP INDEX IF EXISTS idx_users_deleted_at;
ALTER TABLE users DROP COLUMN IF EXISTS deletion_token_hash;
ALTER TABLE users DROP COLUMN IF EXISTS deleted_at;
