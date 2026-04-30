-- 24-hour grace period before an account hard-delete. DELETE /me sets these
-- fields and emails a cancel-link with the plaintext token; only the hash is
-- stored. After the grace window a sweeper purges the row + cascade.

ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN deletion_token_hash TEXT;

-- Partial index — overwhelming majority of rows have deleted_at = NULL, so a
-- partial index keeps the sweep cheap without bloating the b-tree.
CREATE INDEX idx_users_deleted_at ON users(deleted_at) WHERE deleted_at IS NOT NULL;
CREATE UNIQUE INDEX idx_users_deletion_token_hash ON users(deletion_token_hash) WHERE deletion_token_hash IS NOT NULL;
