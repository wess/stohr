ALTER TABLE file_versions ADD COLUMN scan_status text NOT NULL DEFAULT 'pending', ADD COLUMN scan_signature text, ADD COLUMN scanned_at timestamp;
CREATE INDEX file_versions_scan_pending ON file_versions (id) WHERE scan_status IN ('pending', 'error');
