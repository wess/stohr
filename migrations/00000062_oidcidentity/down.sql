-- refuse rollback if identities from distinct issuers would collide
ALTER TABLE external_identities ADD CONSTRAINT external_identities_provider_subject_key UNIQUE (provider, subject);
ALTER TABLE external_identities DROP CONSTRAINT external_identities_provider_issuer_subject_key;
ALTER TABLE external_identities DROP COLUMN issuer;
