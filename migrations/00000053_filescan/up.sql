-- ClamAV async malware scanning + download gating.
--
-- scan_status lifecycle: pending -> clean | infected | error | skipped.
-- When CLAMD_HOST is unset, new uploads are written as 'skipped' so nothing
-- is ever gated and existing deployments are unaffected. The background
-- sweep (sweepPendingScans) only acts on rows still 'pending', which only
-- exist when clamd is configured.
--
-- DEFAULT is 'pending': rows that predate this migration become 'pending'.
-- That is intentional only when clamd is configured; when it is not, the
-- sweep no-ops and the gate treats every non-'infected' status (including
-- 'pending') as downloadable, so those legacy rows remain reachable.

ALTER TABLE files
  ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN scan_signature TEXT,
  ADD COLUMN scanned_at TIMESTAMPTZ;

-- Partial index for the scan sweep: only rows still awaiting a verdict.
CREATE INDEX files_scan_pending_idx
  ON files (id)
  WHERE deleted_at IS NULL AND scan_status = 'pending';
