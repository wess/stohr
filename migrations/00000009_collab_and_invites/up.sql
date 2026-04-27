ALTER TABLE users ADD COLUMN username TEXT;

WITH ranked AS (
  SELECT id,
         lower(regexp_replace(split_part(email, '@', 1), '[^a-z0-9_]+', '', 'gi')) AS base,
         ROW_NUMBER() OVER (
           PARTITION BY lower(regexp_replace(split_part(email, '@', 1), '[^a-z0-9_]+', '', 'gi'))
           ORDER BY id
         ) AS rn
  FROM users
)
UPDATE users u SET username = CASE
  WHEN r.base = '' THEN 'user' || u.id::text
  WHEN r.rn = 1 THEN r.base
  ELSE r.base || (r.rn - 1)::text
END
FROM ranked r WHERE u.id = r.id;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username);
CREATE INDEX idx_users_username_lower ON users (lower(username));

CREATE TABLE invites (
  id SERIAL PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  email TEXT,
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_invites_token ON invites(token);
CREATE INDEX idx_invites_email_lower ON invites(lower(email)) WHERE email IS NOT NULL;

CREATE TABLE collaborations (
  id SERIAL PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('folder', 'file')),
  resource_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor')),
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  CHECK (user_id IS NOT NULL OR email IS NOT NULL)
);
CREATE INDEX idx_collabs_user ON collaborations(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_collabs_resource ON collaborations(resource_type, resource_id);
CREATE INDEX idx_collabs_email_lower ON collaborations(lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX idx_collabs_user_resource ON collaborations(resource_type, resource_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_collabs_email_resource ON collaborations(resource_type, resource_id, lower(email)) WHERE user_id IS NULL AND email IS NOT NULL;
