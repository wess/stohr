ALTER TABLE shares
  ADD COLUMN password_hash TEXT,
  ADD COLUMN burn_on_view BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_shares_expires_at ON shares(expires_at);
