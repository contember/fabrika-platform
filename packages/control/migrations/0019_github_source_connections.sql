-- Control-owned, non-secret state for the Zerops GitHub source connection.
-- Secrets remain envelope-encrypted in vault; this table stores only vault refs and digests.

CREATE TABLE vault_platform_new (
	id          TEXT PRIMARY KEY,
	scope       TEXT NOT NULL CHECK (scope IN ('app','app-env','platform')),
	label       TEXT,
	ciphertext  TEXT NOT NULL,
	value_iv    TEXT NOT NULL,
	wrapped_dek TEXT NOT NULL,
	dek_iv      TEXT NOT NULL,
	created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
	rotated_at  INTEGER
);

INSERT INTO vault_platform_new SELECT * FROM vault;
DROP TABLE vault;
ALTER TABLE vault_platform_new RENAME TO vault;
CREATE INDEX idx_vault_scope ON vault(scope);

CREATE TABLE github_source_setup_attempts (
	id                          TEXT PRIMARY KEY,
	status                      TEXT NOT NULL CHECK (status IN ('active','repair_required','completed','failed')),
	phase                       TEXT NOT NULL CHECK (phase IN (
		'awaiting_manifest_callback',
		'exchange_claimed',
		'recovery_stored',
		'source_bundle_written',
		'source_activated',
		'webhook_secret_stored',
		'webhook_configured',
		'configuration_verified',
		'installation_required',
		'connected'
	)),
	version                     INTEGER NOT NULL CHECK (version >= 1),
	state_hash                  TEXT UNIQUE,
	initiated_by                TEXT NOT NULL,
	expected_origin             TEXT NOT NULL,
	desired_owner               TEXT NOT NULL,
	desired_app_name            TEXT NOT NULL,
	desired_public              INTEGER NOT NULL CHECK (desired_public IN (0, 1)),
	requested_repositories_json TEXT NOT NULL,
	app_id                      TEXT,
	app_slug                    TEXT,
	app_html_url                TEXT,
	credential_sha256           TEXT,
	recovery_secret_ref         TEXT,
	webhook_secret_ref          TEXT,
	last_error_code             TEXT,
	created_at                  INTEGER NOT NULL,
	updated_at                  INTEGER NOT NULL,
	expires_at                  INTEGER NOT NULL,
	terminal_at                 INTEGER,
	CHECK ((status = 'active' AND phase = 'awaiting_manifest_callback' AND state_hash IS NOT NULL) OR state_hash IS NULL),
	CHECK ((status = 'completed') = (phase = 'connected')),
	CHECK (state_hash IS NULL OR (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*')),
	CHECK (credential_sha256 IS NULL OR (length(credential_sha256) = 64 AND credential_sha256 NOT GLOB '*[^0-9a-f]*')),
	CHECK (recovery_secret_ref IS NULL OR recovery_secret_ref LIKE 'vault:%'),
	CHECK (webhook_secret_ref IS NULL OR webhook_secret_ref LIKE 'vault:%'),
	CHECK (status NOT IN ('completed','failed') OR terminal_at IS NOT NULL)
);

CREATE UNIQUE INDEX idx_github_source_setup_active
	ON github_source_setup_attempts((1)) WHERE status = 'active';
CREATE INDEX idx_github_source_setup_status ON github_source_setup_attempts(status, updated_at);

CREATE TABLE github_source_connections (
	singleton                   INTEGER PRIMARY KEY CHECK (singleton = 1),
	connection_id               TEXT NOT NULL UNIQUE,
	app_id                      TEXT NOT NULL,
	app_slug                    TEXT NOT NULL,
	app_html_url                TEXT NOT NULL,
	app_owner                   TEXT NOT NULL,
	app_name                    TEXT NOT NULL,
	app_public                  INTEGER NOT NULL CHECK (app_public IN (0, 1)),
	credential_sha256           TEXT NOT NULL,
	webhook_url                 TEXT NOT NULL,
	webhook_secret_ref          TEXT NOT NULL,
	installation_id             INTEGER NOT NULL CHECK (installation_id > 0),
	installation_account_login  TEXT NOT NULL,
	installation_selection      TEXT NOT NULL CHECK (installation_selection IN ('all','selected')),
	verified_repositories_json  TEXT NOT NULL,
	requested_repositories_json TEXT NOT NULL,
	connected_by                TEXT NOT NULL,
	connected_at                INTEGER NOT NULL,
	verified_at                 INTEGER NOT NULL,
	version                     INTEGER NOT NULL CHECK (version >= 1),
	CHECK (length(credential_sha256) = 64 AND credential_sha256 NOT GLOB '*[^0-9a-f]*'),
	CHECK (webhook_secret_ref LIKE 'vault:%')
);
