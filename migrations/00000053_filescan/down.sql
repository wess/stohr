DROP INDEX IF EXISTS files_scan_pending_idx;
ALTER TABLE files
  DROP COLUMN IF EXISTS scanned_at,
  DROP COLUMN IF EXISTS scan_signature,
  DROP COLUMN IF EXISTS scan_status;
