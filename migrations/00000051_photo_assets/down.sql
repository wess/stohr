DROP INDEX IF EXISTS files_captured_at_idx;
DROP INDEX IF EXISTS files_photo_asset_user_idx;
ALTER TABLE files
  DROP COLUMN IF EXISTS captured_at,
  DROP COLUMN IF EXISTS photo_asset_id;
