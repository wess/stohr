DROP INDEX IF EXISTS users_suspended_idx;
ALTER TABLE users
  DROP COLUMN IF EXISTS suspended_by,
  DROP COLUMN IF EXISTS suspended_reason,
  DROP COLUMN IF EXISTS suspended_at;
