-- One-time bump: invite-only beta users were defaulting to the free tier (5 GB).
-- Lift everyone who's still on free + not the owner to the personal tier (50 GB)
-- so beta testers have realistic room while still being capped.
UPDATE users
SET tier = 'personal',
    storage_quota_bytes = 53687091200
WHERE tier = 'free'
  AND is_owner = false;
