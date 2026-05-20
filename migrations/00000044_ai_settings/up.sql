CREATE TABLE ai_settings (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai', 'anthropic', 'local')),
  api_key TEXT,
  base_url TEXT,
  chat_model TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Single-row config table; we always read/write id=1. Mirrors payment_config.
INSERT INTO ai_settings (provider) VALUES ('openai');
