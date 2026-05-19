-- Owner-controlled toggles for instance-wide features (WebDAV, federation,
-- and whatever else gets gated later). Plain key/value rows; values are
-- JSON-encoded strings so booleans, numbers, and tiny objects all fit.
-- Default state is "absent" → feature off. The admin UI inserts a row to
-- turn a feature on and updates it to turn it off again; we never delete.
CREATE TABLE instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
