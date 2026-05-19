-- Per-user WebDAV credentials. Stohr's WebDAV endpoint requires a separate
-- credential because OS-level WebDAV clients (macOS Finder, Windows File
-- Explorer, etc.) speak HTTP Basic and cannot present session JWTs or PATs.
-- This row stores a hashed WebDAV password distinct from the account password.
-- Disabled (token_hash NULL) means WebDAV is off for this user even if the
-- server-wide WEBDAV_ENABLED setting is on.
CREATE TABLE webdav_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_webdav_credentials_enabled ON webdav_credentials(enabled) WHERE enabled = TRUE;
