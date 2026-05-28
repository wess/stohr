-- Owner can suspend a user account. Suspension is reversible (unlike
-- account deletion which has the 24h hard-delete sweep). While suspended:
--   * Login is rejected with a clear error (no fingerprint timing leak —
--     the suspended check runs after the password verify).
--   * Every existing session/PAT/OAuth-token is rejected at requireAuth.
--   * The user's data stays intact and visible to the owner.
ALTER TABLE users
  ADD COLUMN suspended_at TIMESTAMPTZ,
  ADD COLUMN suspended_reason TEXT,
  ADD COLUMN suspended_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX users_suspended_idx ON users (suspended_at) WHERE suspended_at IS NOT NULL;
