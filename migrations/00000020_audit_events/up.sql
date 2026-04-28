CREATE TABLE audit_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event TEXT NOT NULL,
  metadata JSONB,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_user ON audit_events(user_id);
CREATE INDEX idx_audit_event ON audit_events(event);
CREATE INDEX idx_audit_created ON audit_events(created_at DESC);
