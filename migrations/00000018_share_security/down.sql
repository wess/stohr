DROP INDEX IF EXISTS idx_shares_expires_at;
ALTER TABLE shares
  DROP COLUMN IF EXISTS password_hash,
  DROP COLUMN IF EXISTS burn_on_view;
