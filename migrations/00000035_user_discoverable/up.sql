-- Privacy: opt-out of being found by username/name in /users/search and the
-- public /u/:username lookup. Defaults to TRUE so existing accounts stay
-- discoverable; users can flip it via PATCH /me { discoverable: false }.

ALTER TABLE users ADD COLUMN discoverable BOOLEAN NOT NULL DEFAULT TRUE;

-- Most queries filter on (deleted_at IS NULL AND discoverable = TRUE) so a
-- partial index on the active set keeps lookup cheap.
CREATE INDEX idx_users_discoverable ON users(discoverable) WHERE discoverable = FALSE;
