-- Seen (peer, nonce) pairs from signed peer requests. A request whose pair
-- is already here is a replay inside the signature's timestamp window and
-- is refused. The sweep drops rows older than that window — the timestamp
-- check rejects anything that old on its own.
CREATE TABLE federation_nonces (
  peer_pubkey TEXT NOT NULL,
  nonce TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (peer_pubkey, nonce)
);
CREATE INDEX idx_federation_nonces_seen ON federation_nonces(seen_at);
