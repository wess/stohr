-- Billing removed: drop the Lemon Squeezy subscription machinery and the
-- per-user tier/subscription columns. `storage_quota_bytes` stays — it is now
-- a plain admin-set per-user cap (0 = unlimited), decoupled from any tier.

DROP TABLE IF EXISTS lemonsqueezy_events;
DROP TABLE IF EXISTS payment_config;

DROP INDEX IF EXISTS idx_users_tier;
DROP INDEX IF EXISTS idx_users_ls_subscription;
DROP INDEX IF EXISTS idx_users_ls_customer;

ALTER TABLE users DROP COLUMN IF EXISTS tier;
ALTER TABLE users DROP COLUMN IF EXISTS ls_customer_id;
ALTER TABLE users DROP COLUMN IF EXISTS ls_subscription_id;
ALTER TABLE users DROP COLUMN IF EXISTS subscription_status;
ALTER TABLE users DROP COLUMN IF EXISTS subscription_renews_at;

-- New signups now default to unlimited. The owner sets caps explicitly in
-- Admin → Users. Existing per-user caps are left as-is.
ALTER TABLE users ALTER COLUMN storage_quota_bytes SET DEFAULT 0;
