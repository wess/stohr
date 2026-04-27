ALTER TABLE invite_requests ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE invite_requests ADD COLUMN processed_at TIMESTAMPTZ;
ALTER TABLE invite_requests ADD COLUMN processed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX idx_invite_requests_status ON invite_requests(status, created_at DESC);
