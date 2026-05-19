-- Tracks full-copy placements for content-sharing federations. Each row is
-- one (blob, peer) tuple: blob_id is the federation-wide identifier (a UUID
-- minted at upload time); peer_pubkey identifies a member holding the copy.
-- N replicas of the same blob produce N rows. local_storage_key is set
-- only on the local instance's rows — i.e. when peer_pubkey matches our
-- instance pubkey.
CREATE TABLE federation_blobs (
  id SERIAL PRIMARY KEY,
  federation_id INTEGER NOT NULL REFERENCES federations(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL,
  size BIGINT NOT NULL,
  owner_pubkey TEXT NOT NULL,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  peer_pubkey TEXT NOT NULL,
  local_storage_key TEXT,
  encrypted_metadata TEXT,
  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_federation_blobs_placement ON federation_blobs(federation_id, blob_id, peer_pubkey);
CREATE INDEX idx_federation_blobs_blob ON federation_blobs(federation_id, blob_id);
CREATE INDEX idx_federation_blobs_owner ON federation_blobs(owner_pubkey);
CREATE INDEX idx_federation_blobs_peer ON federation_blobs(peer_pubkey);
CREATE INDEX idx_federation_blobs_file ON federation_blobs(file_id) WHERE file_id IS NOT NULL;
