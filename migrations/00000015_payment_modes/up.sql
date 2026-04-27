ALTER TABLE payment_config ADD COLUMN mode TEXT NOT NULL DEFAULT 'test';
ALTER TABLE payment_config ADD COLUMN live_webhook_secret TEXT;
ALTER TABLE payment_config ADD COLUMN live_tier_personal_monthly TEXT;
ALTER TABLE payment_config ADD COLUMN live_tier_personal_yearly TEXT;
ALTER TABLE payment_config ADD COLUMN live_tier_pro_monthly TEXT;
ALTER TABLE payment_config ADD COLUMN live_tier_pro_yearly TEXT;
ALTER TABLE payment_config ADD COLUMN live_tier_studio_monthly TEXT;
ALTER TABLE payment_config ADD COLUMN live_tier_studio_yearly TEXT;
