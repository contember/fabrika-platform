ALTER TABLE releases ADD COLUMN release_name TEXT;
ALTER TABLE releases ADD COLUMN artifact_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE releases ADD COLUMN updated_at INTEGER;

UPDATE releases
SET release_name = id, updated_at = created_at
WHERE release_name IS NULL;

CREATE UNIQUE INDEX idx_releases_source_name
	ON releases(source_id, release_name)
	WHERE release_name IS NOT NULL;
CREATE UNIQUE INDEX idx_releases_source_commit
	ON releases(source_id, commit_sha);

CREATE TABLE deploy_run_links (
	run_id              TEXT PRIMARY KEY,
	source_id           TEXT NOT NULL REFERENCES sources(id),
	release_id          TEXT REFERENCES releases(id),
	availability        TEXT NOT NULL,
	unavailable_reason  TEXT,
	phase               TEXT NOT NULL,
	provider_run_id     TEXT,
	outcome             TEXT,
	artifact_state      TEXT NOT NULL,
	projection_revision INTEGER NOT NULL,
	projection_hash     TEXT NOT NULL,
	observed_at         INTEGER NOT NULL,
	updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_deploy_run_links_release ON deploy_run_links(release_id, observed_at);

CREATE TABLE artifact_upload_credentials (
	id               TEXT PRIMARY KEY,
	run_id           TEXT NOT NULL UNIQUE REFERENCES deploy_run_links(run_id),
	release_id       TEXT NOT NULL REFERENCES releases(id),
	verifier         TEXT NOT NULL UNIQUE,
	expires_at       INTEGER NOT NULL,
	revoked_at       INTEGER,
	uploaded_bytes   INTEGER NOT NULL DEFAULT 0,
	artifact_count   INTEGER NOT NULL DEFAULT 0,
	last_upload_id   TEXT
);
CREATE INDEX idx_artifact_upload_credentials_validity
	ON artifact_upload_credentials(verifier, expires_at, revoked_at);

ALTER TABLE source_maps ADD COLUMN digest TEXT;
ALTER TABLE source_maps ADD COLUMN byte_length INTEGER;

CREATE INDEX idx_source_maps_digest
	ON source_maps(release_id, digest)
	WHERE digest IS NOT NULL;
