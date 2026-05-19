-- Tracks erasure-coded shard placements for space-offering federations.
-- Reed-Solomon parameters: shard_k of shard_m are needed to reconstruct.
-- shard_index is in [0, shard_m). One row per (blob, shard_index) — only
-- one peer holds each unique shard. local_storage_key set if we're that
-- peer.
CREATE TABLE federation_shards (
  id SERIAL PRIMARY KEY,
  federation_id INTEGER NOT NULL REFERENCES federations(id) ON DELETE CASCADE,
  blob_id TEXT NOT NULL,
  shard_index INTEGER NOT NULL,
  shard_k INTEGER NOT NULL,
  shard_m INTEGER NOT NULL,
  size BIGINT NOT NULL,
  total_size BIGINT NOT NULL,
  owner_pubkey TEXT NOT NULL,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  peer_pubkey TEXT NOT NULL,
  local_storage_key TEXT,
  encrypted_metadata TEXT,
  file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_federation_shards_unique ON federation_shards(federation_id, blob_id, shard_index);
CREATE INDEX idx_federation_shards_blob ON federation_shards(federation_id, blob_id);
CREATE INDEX idx_federation_shards_owner ON federation_shards(owner_pubkey);
CREATE INDEX idx_federation_shards_peer ON federation_shards(peer_pubkey);
CREATE INDEX idx_federation_shards_file ON federation_shards(file_id) WHERE file_id IS NOT NULL;
