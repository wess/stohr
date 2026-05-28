-- Per-file / per-folder discussion threads. Comments belong to a resource
-- (file or folder) and can optionally reference a parent comment to form a
-- single-level reply thread. Soft-deleted so audit context stays intact.

CREATE TABLE comments (
  id SERIAL PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('file', 'folder')),
  resource_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX comments_resource_idx ON comments (resource_type, resource_id, created_at DESC);
CREATE INDEX comments_user_id_idx ON comments (user_id);

-- Notifications inbox. payload is a JSON-encoded TEXT for the same reason
-- audit_events.metadata is — we keep schema migrations cheap and read-side
-- consumers can parse selectively.
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  resource_type TEXT,
  resource_id INTEGER,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  payload TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX notifications_user_unread_idx
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX notifications_user_all_idx
  ON notifications (user_id, created_at DESC);
