-- Private mailbox: user↔user direct messages and system→user announcements.
--
-- thread_id ties replies into a conversation. The first message in a thread
-- sets thread_id = its own id (we backfill via UPDATE after the INSERT in
-- application code). Subsequent replies inherit the same thread_id.
--
-- from_user_id is NULL for system-generated messages (welcome, account
-- suspended, quota warnings, etc); rendering layers show "Stohr" for these.

CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  parent_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  from_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'system')),
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX messages_inbox_idx
  ON messages (to_user_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX messages_unread_idx
  ON messages (to_user_id)
  WHERE read_at IS NULL AND deleted_at IS NULL;
CREATE INDEX messages_sent_idx
  ON messages (from_user_id, created_at DESC)
  WHERE deleted_at IS NULL AND from_user_id IS NOT NULL;
CREATE INDEX messages_thread_idx ON messages (thread_id, created_at ASC);
