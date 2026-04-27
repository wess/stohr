DROP INDEX IF EXISTS idx_invite_requests_status;
ALTER TABLE invite_requests DROP COLUMN IF EXISTS processed_by;
ALTER TABLE invite_requests DROP COLUMN IF EXISTS processed_at;
ALTER TABLE invite_requests DROP COLUMN IF EXISTS status;
