-- A folder can be designated as a federation mount-point. Two roles exist:
--  - 'contribution': this folder holds shards/copies hosted for the federation.
--                    Its disk usage (federation_quota_bytes cap) is what the
--                    member is offering. Contents are not user-readable in
--                    space-offering mode (encrypted shards) and are co-mingled
--                    federation content in content-sharing mode.
--  - 'mount':        a virtual view of federation content visible to the user.
--                    Only meaningful in content-sharing mode (in space-offering
--                    mode, users see their own files in normal folders).
-- A user has at most one contribution folder per federation; the unique index
-- below enforces that. federation_quota_bytes is 0 for non-contribution rows.
ALTER TABLE folders
  ADD COLUMN federation_id INTEGER REFERENCES federations(id) ON DELETE SET NULL,
  ADD COLUMN federation_role TEXT CHECK (federation_role IN ('contribution','mount')),
  ADD COLUMN federation_quota_bytes BIGINT NOT NULL DEFAULT 0;

CREATE INDEX idx_folders_federation ON folders(federation_id) WHERE federation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_folders_one_contribution_per_user_fed
  ON folders(user_id, federation_id, federation_role)
  WHERE federation_role = 'contribution' AND deleted_at IS NULL;
