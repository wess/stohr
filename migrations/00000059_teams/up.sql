-- Teams are hard tenant boundaries on one instance. Team 1 is the root
-- (the instance owner's own team and the control plane); every existing
-- user lands there. quota_bytes NULL means unlimited.
CREATE TABLE teams (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  quota_bytes BIGINT,
  suspended_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO teams (id, slug, name) VALUES (1, 'root', 'Stohr') ON CONFLICT (id) DO NOTHING;
-- the explicit id above does not advance the sequence
SELECT setval(pg_get_serial_sequence('teams', 'id'), GREATEST((SELECT MAX(id) FROM teams), 1));

ALTER TABLE users
  ADD COLUMN team_id INTEGER NOT NULL DEFAULT 1 REFERENCES teams(id),
  ADD COLUMN team_admin BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX idx_users_team_id ON users(team_id);

-- an invite only redeems on its team's host and the new user joins that team
ALTER TABLE invites ADD COLUMN team_id INTEGER NOT NULL DEFAULT 1 REFERENCES teams(id) ON DELETE CASCADE;
CREATE INDEX idx_invites_team_id ON invites(team_id);

-- nullable: events with no actor (failed logins by ip, unknown tokens) have
-- no team unless the caller supplies one
ALTER TABLE audit_events ADD COLUMN team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL;
UPDATE audit_events a SET team_id = u.team_id FROM users u WHERE u.id = a.user_id AND a.team_id IS NULL;
CREATE INDEX idx_audit_events_team_created ON audit_events(team_id, created_at DESC);
