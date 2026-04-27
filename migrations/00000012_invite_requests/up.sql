CREATE TABLE invite_requests (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_invite_requests_email ON invite_requests(lower(email));
CREATE INDEX idx_invite_requests_created ON invite_requests(created_at DESC);
