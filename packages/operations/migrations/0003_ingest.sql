ALTER TABLE sources ADD COLUMN ingest_project_id TEXT;

CREATE UNIQUE INDEX idx_sources_ingest_project_id
	ON sources(ingest_project_id)
	WHERE ingest_project_id IS NOT NULL;

CREATE INDEX idx_ingest_credentials_source_validity
	ON ingest_credentials(source_id, revoked_at, expires_at);

CREATE TABLE ingest_rate_limits (
	source_id      TEXT NOT NULL REFERENCES sources(id),
	window_start   INTEGER NOT NULL,
	consumed_count INTEGER NOT NULL,
	updated_at     INTEGER NOT NULL,
	PRIMARY KEY (source_id, window_start)
);
CREATE INDEX idx_ingest_rate_limits_expiry ON ingest_rate_limits(window_start);
