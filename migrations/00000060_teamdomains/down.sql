ALTER TABLE teams DROP CONSTRAINT team_domain_state;
ALTER TABLE teams DROP COLUMN domain_verified_at, DROP COLUMN domain_token, DROP COLUMN custom_domain;
