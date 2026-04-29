-- Cannot reverse the hashing — restoring plaintext requires re-issuing
-- invites. The down migration restores the schema shape so the previous
-- code can run; it does not recover any pre-hash plaintext.

DROP INDEX IF EXISTS idx_invites_token_hash;
ALTER TABLE invites ADD COLUMN token TEXT;
UPDATE invites SET token = 'invalidated-' || id WHERE token IS NULL;
ALTER TABLE invites ALTER COLUMN token SET NOT NULL;
ALTER TABLE invites DROP COLUMN token_hash;
CREATE UNIQUE INDEX idx_invites_token ON invites(token);
