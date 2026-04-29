CREATE TABLE contact_messages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'handled', 'spam')),
  ip TEXT,
  user_agent TEXT,
  handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The admin list filters by status and orders newest-first; one composite
-- index covers both shapes (the column-1 prefix serves status-only scans).
CREATE INDEX idx_contact_messages_status_created
  ON contact_messages(status, created_at DESC);
