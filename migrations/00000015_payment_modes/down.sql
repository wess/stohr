ALTER TABLE payment_config DROP COLUMN IF EXISTS live_tier_studio_yearly;
ALTER TABLE payment_config DROP COLUMN IF EXISTS live_tier_studio_monthly;
ALTER TABLE payment_config DROP COLUMN IF EXISTS live_tier_pro_yearly;
ALTER TABLE payment_config DROP COLUMN IF EXISTS live_tier_pro_monthly;
ALTER TABLE payment_config DROP COLUMN IF EXISTS live_tier_personal_yearly;
ALTER TABLE payment_config DROP COLUMN IF EXISTS live_tier_personal_monthly;
ALTER TABLE payment_config DROP COLUMN IF EXISTS live_webhook_secret;
ALTER TABLE payment_config DROP COLUMN IF EXISTS mode;
