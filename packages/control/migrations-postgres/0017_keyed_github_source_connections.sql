-- Additive multi-organization GitHub source state. The historical singleton remains durable
-- compatibility evidence; all runtime collection reads use the keyed table below.

CREATE TABLE github_source_connections_keyed (
	connection_id               TEXT PRIMARY KEY,
	transport_kind              TEXT NOT NULL CHECK (transport_kind IN ('legacy-v1','keyed-v2')),
	app_id                      TEXT NOT NULL,
	app_slug                    TEXT NOT NULL,
	app_html_url                TEXT NOT NULL,
	app_owner                   TEXT NOT NULL,
	app_name                    TEXT NOT NULL,
	app_public                  INTEGER NOT NULL CHECK (app_public IN (0, 1)),
	credential_sha256           TEXT NOT NULL CHECK (credential_sha256 ~ '^[0-9a-f]{64}$'),
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
	version                     INTEGER NOT NULL CHECK (version >= 1),
	CHECK (transport_kind <> 'keyed-v2' OR app_public = 0)
);

INSERT INTO github_source_connections_keyed (
	connection_id, transport_kind, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
	credential_sha256, webhook_url, webhook_secret_ref, installation_id,
	installation_account_login, installation_selection, verified_repositories_json,
	requested_repositories_json, connected_by, connected_at, verified_at, version
)
SELECT connection_id, 'legacy-v1', app_id, app_slug, app_html_url, app_owner, app_name, app_public,
	credential_sha256, webhook_url, webhook_secret_ref, installation_id,
	installation_account_login, installation_selection, verified_repositories_json,
	requested_repositories_json, connected_by, connected_at, verified_at, version
FROM github_source_connections
WHERE singleton = 1
ON CONFLICT (connection_id) DO NOTHING;

CREATE UNIQUE INDEX idx_github_source_connections_keyed_legacy
	ON github_source_connections_keyed((1)) WHERE transport_kind = 'legacy-v1';
CREATE UNIQUE INDEX idx_github_source_connections_keyed_owner
	ON github_source_connections_keyed(lower(app_owner));
CREATE INDEX idx_github_source_connections_keyed_page
	ON github_source_connections_keyed(connection_id);

CREATE FUNCTION prevent_github_source_transport_kind_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.transport_kind IS DISTINCT FROM OLD.transport_kind THEN
		RAISE EXCEPTION 'GitHub source connection transport kind is immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;

CREATE TRIGGER github_source_connections_keyed_transport_immutable
	BEFORE UPDATE OF transport_kind ON github_source_connections_keyed
	FOR EACH ROW EXECUTE FUNCTION prevent_github_source_transport_kind_update();

DROP INDEX idx_github_source_setup_active;
CREATE UNIQUE INDEX idx_github_source_setup_active
	ON github_source_setup_attempts((1)) WHERE status IN ('active','repair_required');

ALTER TABLE apps ADD COLUMN github_connection_id TEXT;
CREATE INDEX idx_apps_github_source_binding ON apps(github_connection_id, github_installation_id);

-- Backfill only unambiguous Zerops-only applications whose installation matches the copied legacy
-- connection. Cloudflare-only and mixed-provider rows remain installation-only evidence.
UPDATE apps
SET github_connection_id = (
	SELECT connection_id
	FROM github_source_connections_keyed
	WHERE transport_kind = 'legacy-v1'
		AND installation_id = apps.github_installation_id
)
WHERE github_connection_id IS NULL
	AND github_installation_id IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM github_source_connections_keyed
		WHERE transport_kind = 'legacy-v1'
			AND installation_id = apps.github_installation_id
	)
	AND EXISTS (
		SELECT 1 FROM app_envs
		WHERE app_envs.app_id = apps.id AND app_envs.provider = 'zerops'
	)
	AND NOT EXISTS (
		SELECT 1 FROM app_envs
		WHERE app_envs.app_id = apps.id AND app_envs.provider <> 'zerops'
	);
