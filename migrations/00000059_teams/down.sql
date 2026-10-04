DROP INDEX IF EXISTS idx_audit_events_team_created;
ALTER TABLE audit_events DROP COLUMN IF EXISTS team_id;

DROP INDEX IF EXISTS idx_invites_team_id;
ALTER TABLE invites DROP COLUMN IF EXISTS team_id;

DROP INDEX IF EXISTS idx_users_team_id;
ALTER TABLE users
  DROP COLUMN IF EXISTS team_admin,
  DROP COLUMN IF EXISTS team_id;

DROP TABLE IF EXISTS teams;
