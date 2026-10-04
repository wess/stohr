-- Webhook delivery records keep status + duration only. The receiver's
-- response body was being stored verbatim and served back through the API,
-- which turned every webhook target into a stored, attacker-controlled blob.
ALTER TABLE webhook_deliveries DROP COLUMN IF EXISTS response_body;
