-- No-op: we don't want to undo a tier bump (would surprise users with
-- their files suddenly over quota). Manually reset specific users via
-- the admin UI if needed.
SELECT 1;
