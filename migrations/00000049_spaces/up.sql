-- Team workspaces (a.k.a. "Spaces"). A Space is a separate tree of
-- folders and files that multiple users can co-own. It complements (does
-- not replace) the per-user "My Files" tree.
--
-- Permissions model:
--   * The space row has an owner (the user who created it). Ownership can
--     be transferred but never null.
--   * space_members maps users → role within the space (admin | editor |
--     viewer). The owner is always an admin and implicit; we still write
--     a row for them so listing members is one query.
--   * folders.space_id is NULLABLE — NULL means "personal drive of the
--     row's user_id" (existing behavior). A non-null space_id pins the
--     folder to a Space; users still resolve via space_members instead of
--     ownership.
--   * The folder.user_id of a Space folder is whoever uploaded/created
--     it, used for audit and quota attribution, NOT for permission
--     checks.
--
-- Slug is stable and used in URLs. Unique across the instance — the
-- listing of "your spaces" stays cheap and there's only ever one row
-- you can link to a given slug.

CREATE TABLE spaces (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX spaces_owner_idx ON spaces (owner_id) WHERE deleted_at IS NULL;

CREATE TABLE space_members (
  id SERIAL PRIMARY KEY,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (space_id, user_id)
);
CREATE INDEX space_members_user_idx ON space_members (user_id);

-- Attach a folder to a Space. Files inherit from their parent folder so
-- we don't need a column on files (when a folder belongs to a space, all
-- files inside it do too).
ALTER TABLE folders
  ADD COLUMN space_id INTEGER REFERENCES spaces(id) ON DELETE CASCADE;
CREATE INDEX folders_space_idx ON folders (space_id) WHERE deleted_at IS NULL;
