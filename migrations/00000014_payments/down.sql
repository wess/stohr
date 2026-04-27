DROP TABLE IF EXISTS lemonsqueezy_events;
DROP TABLE IF EXISTS payment_config;

DROP INDEX IF EXISTS idx_users_tier;
DROP INDEX IF EXISTS idx_users_ls_subscription;
DROP INDEX IF EXISTS idx_users_ls_customer;

ALTER TABLE users DROP COLUMN IF EXISTS subscription_renews_at;
ALTER TABLE users DROP COLUMN IF EXISTS subscription_status;
ALTER TABLE users DROP COLUMN IF EXISTS ls_subscription_id;
ALTER TABLE users DROP COLUMN IF EXISTS ls_customer_id;
ALTER TABLE users DROP COLUMN IF EXISTS storage_quota_bytes;
ALTER TABLE users DROP COLUMN IF EXISTS tier;
