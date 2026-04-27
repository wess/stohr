DROP TABLE IF EXISTS collaborations;
DROP TABLE IF EXISTS invites;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_unique;
DROP INDEX IF EXISTS idx_users_username_lower;
ALTER TABLE users DROP COLUMN IF EXISTS username;
