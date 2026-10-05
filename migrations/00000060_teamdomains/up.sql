ALTER TABLE teams
  ADD COLUMN custom_domain text UNIQUE,
  ADD COLUMN domain_token text,
  ADD COLUMN domain_verified_at timestamptz;
ALTER TABLE teams ADD CONSTRAINT team_domain_state CHECK (
  (custom_domain IS NULL AND domain_token IS NULL AND domain_verified_at IS NULL)
  OR (custom_domain IS NOT NULL AND domain_token IS NOT NULL AND id <> 1)
);
