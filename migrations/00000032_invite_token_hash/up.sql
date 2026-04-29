-- Hash invite tokens at rest. A DB leak should not yield usable invite codes.
-- The plaintext column is dropped; the API surfaces the plaintext only at
-- creation time (in the INSERT response), mirroring how PATs / app tokens
-- are handled elsewhere in the codebase.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE invites ADD COLUMN token_hash TEXT;

-- Backfill any pre-existing rows by hashing the existing plaintext token.
UPDATE invites SET token_hash = encode(digest(token, 'sha256'), 'hex') WHERE token_hash IS NULL;

-- Now enforce shape and replace the index/unique-constraint on the plaintext.
ALTER TABLE invites ALTER COLUMN token_hash SET NOT NULL;
DROP INDEX IF EXISTS idx_invites_token;
ALTER TABLE invites DROP COLUMN token;
CREATE UNIQUE INDEX idx_invites_token_hash ON invites(token_hash);
