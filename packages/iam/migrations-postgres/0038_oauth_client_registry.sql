-- The OAuth clients IAM serves and the external applications they sign people in to (ADR-0089). Postgres dialect;
-- `../migrations/0038_oauth_client_registry.sql` states the same outcome.
--
-- An external application is an app id IAM knows with no deploy target: its identity resource here, its display name in
-- `app_presentation` and its roles as its vocabulary, written together by `externalApps.put`. A client row bound to
-- one (`external_app`) is served that application's resource alone; an unbound one is an MCP authoring client.
-- `redirect_uris` is a JSON array of exact URIs. `oauth_registry` holds one row once the deploy variable was imported;
-- until then IAM serves the clients of `OAUTH_CONFIG`, as every installation did before this file.
CREATE TABLE external_apps (
	app        TEXT PRIMARY KEY,
	resource   TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE oauth_clients (
	client_id     TEXT PRIMARY KEY,
	label         TEXT NOT NULL CHECK (label IN ('claude', 'chatgpt', 'external')),
	redirect_uris TEXT NOT NULL,
	metadata_url  TEXT,
	external_app  TEXT REFERENCES external_apps(app),
	created_at    INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL,
	CHECK (external_app IS NULL OR label = 'external')
);
CREATE INDEX idx_oauth_clients_external_app ON oauth_clients(external_app);
CREATE TABLE oauth_registry (
	id          INTEGER PRIMARY KEY CHECK (id = 1),
	imported_at INTEGER NOT NULL
);
-- Removing a client revokes its grants.
CREATE INDEX idx_oauth_grants_client ON oauth_grants(client_id);
