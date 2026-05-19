-- Per-instance cryptographic identity. Singleton row (id = 1 always).
-- Generated on first request that needs it; persisted so peer pubkeys remain
-- stable across restarts. Two keypairs: Ed25519 for signing peer requests
-- and invite tokens; X25519 for ECDH sealed-box delivery of federation
-- group keys to new members.
CREATE TABLE instance_keys (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL,
  x25519_public_key TEXT NOT NULL,
  x25519_private_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A federation as seen from this instance. private_key is set only on
-- instances that can mint invites (i.e. the founder; expandable to admins
-- later). public_key is always present and is what verifies invite tokens
-- and admin actions. group_key_encrypted is the content-sharing group key
-- sealed to this instance's pubkey — only set for content-sharing type.
CREATE TABLE federations (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('content-sharing', 'space-offering')),
  public_key TEXT NOT NULL,
  private_key TEXT,
  replication_factor INTEGER NOT NULL DEFAULT 3,
  erasure_k INTEGER,
  erasure_m INTEGER,
  quota_multiplier NUMERIC(5,2) NOT NULL DEFAULT 1.0,
  group_key_encrypted TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each row is one user-on-one-instance participating in one federation.
-- is_local TRUE means this row represents a user on THIS instance; FALSE
-- means it represents a peer (a user on a remote Stohr instance). The
-- (federation_id, peer_pubkey, user_id) tuple is unique — same peer can
-- host multiple users; we just need the user_id distinct.
CREATE TABLE federation_members (
  id SERIAL PRIMARY KEY,
  federation_id INTEGER NOT NULL REFERENCES federations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  peer_pubkey TEXT NOT NULL,
  peer_x25519_pubkey TEXT,
  peer_base_url TEXT NOT NULL,
  display_name TEXT,
  is_local BOOLEAN NOT NULL DEFAULT FALSE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  contributed_bytes BIGINT NOT NULL DEFAULT 0,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','draining','left')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_federation_members_unique ON federation_members(federation_id, peer_pubkey, COALESCE(user_id, 0));
CREATE INDEX idx_federation_members_fed ON federation_members(federation_id);
CREATE INDEX idx_federation_members_pubkey ON federation_members(peer_pubkey);
CREATE INDEX idx_federation_members_local ON federation_members(is_local) WHERE is_local = TRUE;

-- Outstanding invite tokens. token_hash is sha256(token); the raw token is
-- only ever returned at mint time. Single-use: used_at flips on accept.
CREATE TABLE federation_invites (
  id SERIAL PRIMARY KEY,
  federation_id INTEGER NOT NULL REFERENCES federations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_pubkey TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_federation_invites_fed ON federation_invites(federation_id);
CREATE INDEX idx_federation_invites_expires ON federation_invites(expires_at);
