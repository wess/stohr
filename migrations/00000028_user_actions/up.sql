CREATE TABLE user_actions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  triggers TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]',
  enabled BOOLEAN NOT NULL DEFAULT true,
  forked_from TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_actions_user ON user_actions(user_id);
