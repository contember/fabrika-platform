-- One-use GitHub manifest state remains encrypted and is consumed atomically with its hash.
ALTER TABLE github_source_setup_attempts
	ADD COLUMN manifest_state_secret_ref TEXT
	CHECK (manifest_state_secret_ref IS NULL OR manifest_state_secret_ref LIKE 'vault:%');

ALTER TABLE github_source_setup_attempts
	ADD COLUMN setup_kind TEXT NOT NULL DEFAULT 'manifest'
	CHECK (setup_kind IN ('manifest','adoption'));
