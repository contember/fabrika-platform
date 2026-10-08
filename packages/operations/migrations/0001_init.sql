-- Operations schema — SQLite/D1 dialect. `../migrations-postgres/0001_init.sql` states the same
-- schema for Postgres; add every later change to both sets. SQLite cannot add NOT NULL to an existing
-- column, so `releases.release_name` and `releases.updated_at` stay nullable here and
-- `idx_releases_source_name` is partial; the writers always set both.

CREATE TABLE sources (
	id                TEXT PRIMARY KEY,
	app_id            TEXT NOT NULL,
	environment       TEXT NOT NULL,
	service_key       TEXT NOT NULL,
	display_name      TEXT NOT NULL,
	enabled           INTEGER NOT NULL,
	created_at        INTEGER NOT NULL,
	updated_at        INTEGER NOT NULL,
	disabled_at       INTEGER,
	origin            TEXT NOT NULL DEFAULT 'control',
	public_origin     TEXT,
	ingest_project_id TEXT,
	UNIQUE (app_id, environment, service_key)
);
CREATE UNIQUE INDEX idx_sources_ingest_project_id
	ON sources(ingest_project_id)
	WHERE ingest_project_id IS NOT NULL;

CREATE TABLE operations_catalog_cursor (
	singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
	revision       INTEGER NOT NULL,
	snapshot_hash  TEXT NOT NULL,
	applied_at     INTEGER NOT NULL
);

INSERT INTO operations_catalog_cursor (singleton, revision, snapshot_hash, applied_at)
VALUES (1, 0, '', 0);

CREATE TABLE ingest_credentials (
	id          TEXT PRIMARY KEY,
	source_id   TEXT NOT NULL REFERENCES sources(id),
	verifier    TEXT NOT NULL UNIQUE,
	created_at  INTEGER NOT NULL,
	expires_at  INTEGER,
	revoked_at  INTEGER
);
CREATE INDEX idx_ingest_credentials_source ON ingest_credentials(source_id, created_at);
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

CREATE TABLE issues (
	source_id             TEXT NOT NULL REFERENCES sources(id),
	fingerprint           TEXT NOT NULL,
	title                 TEXT NOT NULL,
	culprit               TEXT,
	level                 TEXT NOT NULL,
	status                TEXT NOT NULL,
	assigned_to           TEXT,
	assigned_to_label     TEXT,
	first_seen            INTEGER NOT NULL,
	last_seen             INTEGER NOT NULL,
	regressed_at          INTEGER,
	snooze_until          INTEGER,
	snooze_until_count    INTEGER,
	resolved_in_release   TEXT,
	merged_into           TEXT,
	revision              INTEGER NOT NULL DEFAULT 0,
	last_mutation_id      TEXT,
	id                    TEXT,
	PRIMARY KEY (source_id, fingerprint)
);
CREATE INDEX idx_issues_source_status_seen ON issues(source_id, status, last_seen);
CREATE UNIQUE INDEX idx_issues_id
	ON issues(id)
	WHERE id IS NOT NULL;

CREATE TABLE occurrences (
	id            TEXT PRIMARY KEY,
	source_id     TEXT NOT NULL REFERENCES sources(id),
	fingerprint   TEXT NOT NULL,
	event_id      TEXT NOT NULL,
	received_at   INTEGER NOT NULL,
	release       TEXT,
	blob_key      TEXT NOT NULL,
	transition_kind TEXT,
	applied_at    INTEGER,
	UNIQUE (source_id, event_id)
);
CREATE INDEX idx_occurrences_issue_time ON occurrences(source_id, fingerprint, received_at);

CREATE TABLE issue_activity (
	id            TEXT PRIMARY KEY,
	source_id     TEXT NOT NULL,
	fingerprint   TEXT NOT NULL,
	actor_id      TEXT,
	actor_label   TEXT,
	kind          TEXT NOT NULL,
	data          TEXT,
	at            INTEGER NOT NULL,
	FOREIGN KEY (source_id, fingerprint) REFERENCES issues(source_id, fingerprint)
);
CREATE INDEX idx_issue_activity_issue_time ON issue_activity(source_id, fingerprint, at, id);

CREATE TABLE alert_config (
	source_id   TEXT PRIMARY KEY REFERENCES sources(id),
	threshold   INTEGER NOT NULL,
	enabled     INTEGER NOT NULL
);
CREATE TABLE alert_rules (
	source_id   TEXT NOT NULL REFERENCES sources(id),
	type        TEXT NOT NULL,
	enabled     INTEGER NOT NULL,
	PRIMARY KEY (source_id, type)
);
CREATE TABLE notification_channels (
	id          TEXT PRIMARY KEY,
	source_id   TEXT NOT NULL REFERENCES sources(id),
	scope       TEXT NOT NULL,
	type        TEXT NOT NULL,
	target      TEXT NOT NULL,
	enabled     INTEGER NOT NULL
);
CREATE INDEX idx_notification_channels_scope ON notification_channels(source_id, scope, enabled);

CREATE TABLE alert_claims (
	claim_key    TEXT PRIMARY KEY,
	claimed_at   INTEGER NOT NULL,
	expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_alert_claims_expiry ON alert_claims(expires_at);

CREATE TABLE notification_outbox (
	id            TEXT PRIMARY KEY,
	dedup_key     TEXT NOT NULL UNIQUE,
	source_id     TEXT NOT NULL REFERENCES sources(id),
	channel_id    TEXT NOT NULL REFERENCES notification_channels(id),
	kind          TEXT NOT NULL,
	payload       TEXT NOT NULL,
	created_at    INTEGER NOT NULL,
	attempts      INTEGER NOT NULL DEFAULT 0,
	max_attempts  INTEGER NOT NULL DEFAULT 6,
	visible_at    INTEGER NOT NULL,
	claimed_until INTEGER,
	claim_token   TEXT,
	delivered_at  INTEGER,
	abandoned_at  INTEGER
);
CREATE INDEX idx_notification_outbox_pending ON notification_outbox(delivered_at, abandoned_at, visible_at, created_at);
CREATE TABLE notification_attempts (
	id                TEXT PRIMARY KEY,
	notification_id   TEXT NOT NULL REFERENCES notification_outbox(id),
	attempted_at      INTEGER NOT NULL,
	delivered         INTEGER NOT NULL,
	error_code        TEXT
);

CREATE TABLE dead_events (
	id            TEXT PRIMARY KEY,
	source_id     TEXT,
	event_id      TEXT NOT NULL,
	fingerprint   TEXT,
	blob_key      TEXT NOT NULL,
	reason        TEXT NOT NULL,
	attempts      INTEGER NOT NULL,
	dead_at       INTEGER NOT NULL,
	replayed_at   INTEGER,
	UNIQUE (source_id, event_id)
);
CREATE INDEX idx_dead_events_time ON dead_events(dead_at, id);

CREATE TABLE releases (
	id              TEXT PRIMARY KEY,
	source_id       TEXT NOT NULL REFERENCES sources(id),
	run_id          TEXT NOT NULL,
	commit_sha      TEXT NOT NULL,
	state           TEXT NOT NULL,
	created_at      INTEGER NOT NULL,
	finished_at     INTEGER,
	release_name    TEXT,
	artifact_state  TEXT NOT NULL DEFAULT 'pending',
	updated_at      INTEGER,
	UNIQUE (source_id, run_id)
);
CREATE UNIQUE INDEX idx_releases_source_name
	ON releases(source_id, release_name)
	WHERE release_name IS NOT NULL;
CREATE UNIQUE INDEX idx_releases_source_commit ON releases(source_id, commit_sha);

CREATE TABLE source_maps (
	release_id    TEXT NOT NULL REFERENCES releases(id),
	file_name     TEXT NOT NULL,
	blob_key      TEXT NOT NULL,
	uploaded_at   INTEGER NOT NULL,
	digest        TEXT,
	byte_length   INTEGER,
	PRIMARY KEY (release_id, file_name)
);
CREATE INDEX idx_source_maps_digest
	ON source_maps(release_id, digest)
	WHERE digest IS NOT NULL;

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

CREATE TABLE health_checks (
	id                 TEXT PRIMARY KEY,
	source_id          TEXT NOT NULL REFERENCES sources(id),
	url                TEXT NOT NULL,
	enabled            INTEGER NOT NULL,
	created_at         INTEGER NOT NULL,
	updated_at         INTEGER NOT NULL,
	path               TEXT NOT NULL DEFAULT '/health',
	interval_ms        INTEGER NOT NULL DEFAULT 60000,
	timeout_ms         INTEGER NOT NULL DEFAULT 5000,
	expected_status    INTEGER NOT NULL DEFAULT 200,
	failure_threshold  INTEGER NOT NULL DEFAULT 3,
	recovery_threshold INTEGER NOT NULL DEFAULT 2,
	stale_after_ms     INTEGER NOT NULL DEFAULT 180000,
	due_at             INTEGER NOT NULL DEFAULT 0,
	claimed_until      INTEGER,
	claim_token        TEXT
);
CREATE INDEX idx_health_checks_due ON health_checks(enabled, due_at, claimed_until);

CREATE TABLE health_observations (
	id            TEXT PRIMARY KEY,
	check_id      TEXT NOT NULL REFERENCES health_checks(id),
	state         TEXT NOT NULL,
	observed_at   INTEGER NOT NULL,
	latency_ms    INTEGER,
	detail_code   TEXT,
	successful    INTEGER NOT NULL DEFAULT 0,
	status_code   INTEGER,
	transition_id TEXT
);
CREATE INDEX idx_health_observations_check_time ON health_observations(check_id, observed_at);

CREATE TABLE current_health (
	check_id              TEXT PRIMARY KEY REFERENCES health_checks(id),
	state                 TEXT NOT NULL,
	observed_at           INTEGER NOT NULL,
	latency_ms            INTEGER,
	detail_code           TEXT,
	consecutive_failures  INTEGER NOT NULL DEFAULT 0,
	consecutive_successes INTEGER NOT NULL DEFAULT 0,
	transition_id         TEXT
);

CREATE TABLE health_transitions (
	id          TEXT PRIMARY KEY,
	source_id   TEXT NOT NULL REFERENCES sources(id),
	check_id    TEXT REFERENCES health_checks(id),
	kind        TEXT NOT NULL,
	from_state  TEXT,
	to_state    TEXT NOT NULL,
	occurred_at INTEGER NOT NULL
);
CREATE INDEX idx_health_transitions_source_time ON health_transitions(source_id, occurred_at, id);

CREATE TABLE telemetry_health_observations (
	id          TEXT PRIMARY KEY,
	source_id   TEXT NOT NULL REFERENCES sources(id),
	state       TEXT NOT NULL,
	observed_at INTEGER NOT NULL,
	payload     TEXT NOT NULL,
	transition_id TEXT
);
CREATE INDEX idx_telemetry_health_history ON telemetry_health_observations(source_id, observed_at, id);

CREATE TABLE current_telemetry_health (
	source_id   TEXT PRIMARY KEY REFERENCES sources(id),
	state       TEXT NOT NULL,
	observed_at INTEGER NOT NULL,
	payload     TEXT NOT NULL,
	transition_id TEXT
);
