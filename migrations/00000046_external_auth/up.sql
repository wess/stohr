-- External authentication providers: OIDC + LDAP.
--
-- Each provider has its own singleton config row (matches the ai_settings
-- pattern). Both are off by default and configured by the owner in
-- Admin → Auth. Secrets are stored plaintext; protecting the DB is the
-- operator's job (the same row already holds the password-hash pepper,
-- session JWT secret env, etc).

CREATE TABLE oidc_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  issuer_url TEXT,
  client_id TEXT,
  client_secret TEXT,
  scopes TEXT NOT NULL DEFAULT 'openid profile email',
  button_label TEXT NOT NULL DEFAULT 'Sign in with SSO',
  auto_provision BOOLEAN NOT NULL DEFAULT TRUE,
  email_claim TEXT NOT NULL DEFAULT 'email',
  name_claim TEXT NOT NULL DEFAULT 'name',
  username_claim TEXT NOT NULL DEFAULT 'preferred_username',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE ldap_config (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  url TEXT,
  start_tls BOOLEAN NOT NULL DEFAULT FALSE,
  bind_dn TEXT,
  bind_password TEXT,
  user_search_base TEXT,
  user_filter TEXT NOT NULL DEFAULT '(uid={username})',
  email_attr TEXT NOT NULL DEFAULT 'mail',
  name_attr TEXT NOT NULL DEFAULT 'cn',
  username_attr TEXT NOT NULL DEFAULT 'uid',
  auto_provision BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Link table mapping external-provider identities to local users. One
-- local user can be linked to multiple providers (e.g. password + OIDC) but
-- each (provider, subject) pair is unique so a single SSO identity always
-- resolves to exactly one local account.
CREATE TABLE external_identities (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, subject)
);
CREATE INDEX external_identities_user_id_idx ON external_identities (user_id);

-- Short-lived state for the OIDC redirect dance. Holds the PKCE verifier
-- and nonce so the callback can finish the exchange even after the
-- redirect leaves and re-enters the API.
CREATE TABLE oidc_states (
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_to TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX oidc_states_expires_at_idx ON oidc_states (expires_at);

INSERT INTO oidc_config (id) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO ldap_config (id) VALUES (1) ON CONFLICT DO NOTHING;
