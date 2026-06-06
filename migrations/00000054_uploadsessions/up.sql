-- Resumable chunked-upload sessions. One row per in-flight large upload,
-- created by POST /files/upload/init and dropped on finalize, abort, or the
-- 24h TTL sweep (cleanupExpiredUploads).
--
-- id is a 36-char hex token (node:crypto randomBytes(18)). For the S3 driver
-- s3_upload_id holds the InitiateMultipartUpload id and s3_part_etags is a
-- JSON array of {part,etag}; for the local driver both stay NULL and each
-- chunk is staged as its own object (<storage_key>.partN) until concat.
--
-- byte_offset (not "offset", which is a reserved word) is the resumable
-- cursor: bytes durably received so far. chunks_received is the count of
-- completed 5MB parts.
CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  total_size BIGINT NOT NULL,
  mime TEXT NOT NULL,
  chunks_received BIGINT NOT NULL DEFAULT 0,
  byte_offset BIGINT NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  s3_upload_id TEXT,
  s3_part_etags TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The TTL sweep scans by expires_at; the per-user listing/lookup hits user_id.
CREATE INDEX upload_sessions_expires_idx ON upload_sessions (expires_at);
CREATE INDEX upload_sessions_user_idx ON upload_sessions (user_id);
