-- The owner runs the instance and pays for the underlying storage directly.
-- A quota of 0 is interpreted as "unlimited" by checkQuota.
UPDATE users SET storage_quota_bytes = 0 WHERE is_owner = true;
