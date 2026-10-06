ALTER TABLE external_identities ADD COLUMN issuer TEXT NOT NULL DEFAULT '';
UPDATE external_identities
   SET issuer = COALESCE((SELECT issuer_url FROM oidc_config WHERE id = 1), '')
 WHERE provider = 'oidc';
ALTER TABLE external_identities DROP CONSTRAINT external_identities_provider_subject_key;
ALTER TABLE external_identities ADD CONSTRAINT external_identities_provider_issuer_subject_key
  UNIQUE (provider, issuer, subject);
