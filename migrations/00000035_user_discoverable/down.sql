DROP INDEX IF EXISTS idx_users_discoverable;
ALTER TABLE users DROP COLUMN IF EXISTS discoverable;
