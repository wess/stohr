-- Mobile photo-backup support.
--
-- photo_asset_id is the client-side identifier (iOS PHAsset.localIdentifier
-- or Android MediaStore ID). Per (user, asset) it's unique, so an
-- idempotent upload becomes a single INSERT … ON CONFLICT DO UPDATE.
--
-- captured_at is the moment the photo was taken (EXIF DateTimeOriginal on
-- iOS, MediaStore.DATE_TAKEN on Android). We sort the photos timeline by
-- this column when present; otherwise we fall back to created_at.

ALTER TABLE files
  ADD COLUMN photo_asset_id TEXT,
  ADD COLUMN captured_at TIMESTAMPTZ;

-- Partial uniqueness: only rows with a non-null asset_id participate in
-- the constraint. Plain `files` (manual uploads) leave the column NULL
-- and avoid collision.
CREATE UNIQUE INDEX files_photo_asset_user_idx
  ON files (user_id, photo_asset_id)
  WHERE photo_asset_id IS NOT NULL AND deleted_at IS NULL;

-- Range queries over the timeline view need to ORDER BY captured_at;
-- the partial index keeps the cost bounded to actual photo rows.
CREATE INDEX files_captured_at_idx
  ON files (user_id, captured_at DESC)
  WHERE captured_at IS NOT NULL AND deleted_at IS NULL;
