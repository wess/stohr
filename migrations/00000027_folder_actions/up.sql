CREATE TABLE folder_actions (
  id SERIAL PRIMARY KEY,
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  slug TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_folder_actions_lookup
  ON folder_actions(folder_id, event)
  WHERE enabled = true;

CREATE TABLE folder_action_runs (
  id BIGSERIAL PRIMARY KEY,
  folder_action_id INTEGER NOT NULL REFERENCES folder_actions(id) ON DELETE CASCADE,
  triggered_event TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  error TEXT,
  result TEXT
);

CREATE INDEX idx_folder_action_runs_action
  ON folder_action_runs(folder_action_id, started_at DESC);
