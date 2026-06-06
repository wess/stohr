-- Per-user outbound webhooks plus a delivery log.
--
-- A webhook subscribes to a set of events (stored as a JSON text array,
-- matching the folder_actions/user_actions convention in this schema).
-- When `secret` is set, deliveries carry an HMAC-sha256 signature in the
-- X-Stohr-Signature header so receivers can verify authenticity. Each
-- attempt is recorded in webhook_deliveries (fire-and-forget, never blocks
-- the triggering API request) so the SPA can surface failures.

CREATE TABLE webhooks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT,
  content_type TEXT NOT NULL DEFAULT 'application/json',
  events TEXT NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX webhooks_user_idx ON webhooks (user_id, created_at DESC);
CREATE INDEX webhooks_active_idx ON webhooks (user_id) WHERE active;

CREATE TABLE webhook_deliveries (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status_code INTEGER,
  response_body TEXT,
  duration_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX webhook_deliveries_hook_idx
  ON webhook_deliveries (webhook_id, created_at DESC);
