CREATE TABLE s3_access_keys (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_key TEXT NOT NULL UNIQUE,
  secret_key TEXT NOT NULL,
  name TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_s3_keys_user ON s3_access_keys(user_id);
CREATE INDEX idx_s3_keys_access ON s3_access_keys(access_key);
