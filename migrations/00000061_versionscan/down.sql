DROP INDEX file_versions_scan_pending;
ALTER TABLE file_versions DROP COLUMN scanned_at, DROP COLUMN scan_signature, DROP COLUMN scan_status;
