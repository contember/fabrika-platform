-- Control holds every connection's GitHub App key in its vault (ADR-0029). The `source` service's
-- credential slots, the bundle digest that bound them and the one-time recovery entry are gone, and no
-- connection is carried over: there is no production installation, so every App is created again.
-- `apps.github_connection_id` stays. An app bound to a connection that no longer exists fails closed on
-- every private operation and webhook; there is no rebind (D2), so such an app must be deleted and
-- registered again against a newly created connection.

DELETE FROM vault WHERE scope = 'platform' AND label LIKE 'platform:github-source:%';

DROP TABLE github_source_setup_attempts;
DROP TABLE github_source_connections_keyed;

CREATE TABLE github_source_setup_attempts (
	id                          TEXT PRIMARY KEY,
	status                      TEXT NOT NULL CHECK (status IN ('active','repair_required','completed','failed')),
	phase                       TEXT NOT NULL CHECK (phase IN (
		'awaiting_manifest_callback',
		'exchange_claimed',
		'credential_stored',
		'app_verified',
		'webhook_secret_stored',
		'webhook_configured',
		'installation_required',
		'connected'
	)),
	version                     INTEGER NOT NULL CHECK (version >= 1),
	state_hash                  TEXT UNIQUE,
	manifest_state_secret_ref   TEXT CHECK (manifest_state_secret_ref IS NULL OR manifest_state_secret_ref LIKE 'vault:%'),
	initiated_by                TEXT NOT NULL,
	expected_origin             TEXT NOT NULL,
	desired_owner               TEXT NOT NULL,
	desired_app_name            TEXT NOT NULL,
	desired_public              INTEGER NOT NULL CHECK (desired_public IN (0, 1)),
	requested_repositories_json TEXT NOT NULL,
	app_id                      TEXT,
	app_slug                    TEXT,
	app_html_url                TEXT,
	app_credential_ref          TEXT CHECK (app_credential_ref IS NULL OR app_credential_ref LIKE 'vault:%'),
	webhook_secret_ref          TEXT CHECK (webhook_secret_ref IS NULL OR webhook_secret_ref LIKE 'vault:%'),
	last_error_code             TEXT,
	created_at                  INTEGER NOT NULL,
	updated_at                  INTEGER NOT NULL,
	expires_at                  INTEGER NOT NULL,
	terminal_at                 INTEGER,
	CHECK ((status = 'active' AND phase = 'awaiting_manifest_callback' AND state_hash IS NOT NULL) OR state_hash IS NULL),
	CHECK ((status = 'completed') = (phase = 'connected')),
	CHECK (state_hash IS NULL OR (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*')),
	CHECK (status NOT IN ('completed','failed') OR terminal_at IS NOT NULL)
);

CREATE UNIQUE INDEX idx_github_source_setup_active
	ON github_source_setup_attempts((1)) WHERE status IN ('active','repair_required');
CREATE INDEX idx_github_source_setup_status ON github_source_setup_attempts(status, updated_at);

CREATE TABLE github_source_connections_keyed (
	connection_id               TEXT PRIMARY KEY,
	app_id                      TEXT NOT NULL,
	app_slug                    TEXT NOT NULL,
	app_html_url                TEXT NOT NULL,
	app_owner                   TEXT NOT NULL,
	app_name                    TEXT NOT NULL,
	app_public                  INTEGER NOT NULL CHECK (app_public = 0),
	app_credential_ref          TEXT NOT NULL CHECK (app_credential_ref LIKE 'vault:%'),
	webhook_url                 TEXT NOT NULL,
	webhook_secret_ref          TEXT NOT NULL CHECK (webhook_secret_ref LIKE 'vault:%'),
	installation_id             INTEGER NOT NULL CHECK (installation_id > 0),
	installation_account_login  TEXT NOT NULL,
	installation_selection      TEXT NOT NULL CHECK (installation_selection IN ('all','selected')),
	verified_repositories_json  TEXT NOT NULL,
	requested_repositories_json TEXT NOT NULL,
	connected_by                TEXT NOT NULL,
	connected_at                INTEGER NOT NULL,
	verified_at                 INTEGER NOT NULL,
	version                     INTEGER NOT NULL CHECK (version >= 1)
);

CREATE UNIQUE INDEX idx_github_source_connections_keyed_owner
	ON github_source_connections_keyed(lower(app_owner));
CREATE INDEX idx_github_source_connections_keyed_page
	ON github_source_connections_keyed(connection_id);
