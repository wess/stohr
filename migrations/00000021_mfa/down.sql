ALTER TABLE users
  DROP COLUMN IF EXISTS totp_enabled_at,
  DROP COLUMN IF EXISTS totp_backup_codes,
  DROP COLUMN IF EXISTS totp_enabled,
  DROP COLUMN IF EXISTS totp_secret;
