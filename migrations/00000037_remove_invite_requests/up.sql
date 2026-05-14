-- The public "request an invite" waitlist funnel was removed. Invite-only
-- signup still works via admin-minted invite tokens (the `invites` table);
-- only the request-collection table is gone.
DROP TABLE IF EXISTS invite_requests;
