ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN storage_quota_bytes BIGINT NOT NULL DEFAULT 5368709120;
ALTER TABLE users ADD COLUMN ls_customer_id TEXT;
ALTER TABLE users ADD COLUMN ls_subscription_id TEXT;
ALTER TABLE users ADD COLUMN subscription_status TEXT;
ALTER TABLE users ADD COLUMN subscription_renews_at TIMESTAMPTZ;

CREATE INDEX idx_users_ls_customer ON users(ls_customer_id) WHERE ls_customer_id IS NOT NULL;
CREATE INDEX idx_users_ls_subscription ON users(ls_subscription_id) WHERE ls_subscription_id IS NOT NULL;
CREATE INDEX idx_users_tier ON users(tier);

CREATE TABLE payment_config (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'lemonsqueezy',
  api_key TEXT,
  webhook_secret TEXT,
  store_id TEXT,
  store_url TEXT,
  test_mode BOOLEAN NOT NULL DEFAULT TRUE,
  tier_personal_monthly TEXT,
  tier_personal_yearly TEXT,
  tier_pro_monthly TEXT,
  tier_pro_yearly TEXT,
  tier_studio_monthly TEXT,
  tier_studio_yearly TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO payment_config (provider) VALUES ('lemonsqueezy');

CREATE TABLE lemonsqueezy_events (
  id SERIAL PRIMARY KEY,
  event_name TEXT NOT NULL,
  signature_valid BOOLEAN NOT NULL,
  payload TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ls_subscription_id TEXT,
  ls_customer_id TEXT,
  error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_ls_events_received ON lemonsqueezy_events(received_at DESC);
CREATE INDEX idx_ls_events_user ON lemonsqueezy_events(user_id) WHERE user_id IS NOT NULL;
