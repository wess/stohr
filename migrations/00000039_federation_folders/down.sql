DROP INDEX IF EXISTS idx_folders_one_contribution_per_user_fed;
DROP INDEX IF EXISTS idx_folders_federation;
ALTER TABLE folders
  DROP COLUMN IF EXISTS federation_quota_bytes,
  DROP COLUMN IF EXISTS federation_role,
  DROP COLUMN IF EXISTS federation_id;
