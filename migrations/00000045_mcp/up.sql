-- External MCP servers Stohr will connect *out* to. The built-in AI chat
-- (src/ai/*) reads this list to expose third-party MCP tools to the model.
-- Stohr-as-server (POST /mcp) does not use this table — that endpoint just
-- gates on instance_settings flags.
CREATE TABLE mcp_servers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  -- Bearer token sent on every outbound MCP request. Plaintext on purpose;
  -- the operator pastes the third-party-issued token in once and Stohr replays it.
  auth_token TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX mcp_servers_enabled_idx ON mcp_servers (enabled);
