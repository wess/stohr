-- Best-effort restore of the invite_requests table structure (collected
-- request rows are not recoverable).
CREATE TABLE invite_requests (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending',
  processed_at TIMESTAMPTZ,
  processed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_invite_requests_email ON invite_requests(lower(email));
CREATE INDEX idx_invite_requests_created ON invite_requests(created_at DESC);
CREATE INDEX idx_invite_requests_status ON invite_requests(status, created_at DESC);
