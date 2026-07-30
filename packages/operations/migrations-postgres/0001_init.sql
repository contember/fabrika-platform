CREATE TABLE sources (
	id            TEXT PRIMARY KEY,
	app_id        TEXT NOT NULL,
	environment   TEXT NOT NULL,
	service_key   TEXT NOT NULL,
	display_name  TEXT NOT NULL,
	enabled       INTEGER NOT NULL,
	created_at    BIGINT NOT NULL,
	updated_at    BIGINT NOT NULL,
	UNIQUE (app_id, environment, service_key)
);

CREATE TABLE ingest_credentials (
	id          TEXT PRIMARY KEY,
	source_id   TEXT NOT NULL REFERENCES sources(id),
	verifier    TEXT NOT NULL UNIQUE,
	created_at  BIGINT NOT NULL,
	expires_at  BIGINT,
	revoked_at  BIGINT
);
CREATE INDEX idx_ingest_credentials_source ON ingest_credentials(source_id, created_at);

CREATE TABLE issues (
	source_id             TEXT NOT NULL REFERENCES sources(id),
	fingerprint           TEXT NOT NULL,
	title                 TEXT NOT NULL,
	culprit               TEXT,
	level                 TEXT NOT NULL,
	status                TEXT NOT NULL,
	assigned_to           TEXT,
	assigned_to_label     TEXT,
	first_seen            BIGINT NOT NULL,
	last_seen             BIGINT NOT NULL,
	regressed_at          BIGINT,
	snooze_until          BIGINT,
	snooze_until_count    INTEGER,
	resolved_in_release   TEXT,
	merged_into           TEXT,
	revision              INTEGER NOT NULL DEFAULT 0,
	last_mutation_id      TEXT,
	PRIMARY KEY (source_id, fingerprint)
);
CREATE INDEX idx_issues_source_status_seen ON issues(source_id, status, last_seen);

CREATE TABLE occurrences (
	id            TEXT PRIMARY KEY,
	source_id     TEXT NOT NULL REFERENCES sources(id),
	fingerprint   TEXT NOT NULL,
	event_id      TEXT NOT NULL,
	received_at   BIGINT NOT NULL,
	release       TEXT,
	blob_key      TEXT NOT NULL,
	transition_kind TEXT,
	applied_at    BIGINT,
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
	at            BIGINT NOT NULL,
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
	claimed_at   BIGINT NOT NULL,
	expires_at   BIGINT NOT NULL
);
CREATE INDEX idx_alert_claims_expiry ON alert_claims(expires_at);

CREATE TABLE notification_outbox (
	id            TEXT PRIMARY KEY,
	dedup_key     TEXT NOT NULL UNIQUE,
	source_id     TEXT NOT NULL REFERENCES sources(id),
	channel_id    TEXT NOT NULL REFERENCES notification_channels(id),
	kind          TEXT NOT NULL,
	payload       TEXT NOT NULL,
	created_at    BIGINT NOT NULL,
	attempts      INTEGER NOT NULL DEFAULT 0,
	max_attempts  INTEGER NOT NULL DEFAULT 6,
	visible_at    BIGINT NOT NULL,
	claimed_until BIGINT,
	claim_token   TEXT,
	delivered_at  BIGINT,
	abandoned_at  BIGINT
);
CREATE INDEX idx_notification_outbox_pending ON notification_outbox(delivered_at, abandoned_at, visible_at, created_at);
CREATE TABLE notification_attempts (
	id                TEXT PRIMARY KEY,
	notification_id   TEXT NOT NULL REFERENCES notification_outbox(id),
	attempted_at      BIGINT NOT NULL,
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
	dead_at       BIGINT NOT NULL,
	replayed_at   BIGINT,
	UNIQUE (source_id, event_id)
);
CREATE INDEX idx_dead_events_time ON dead_events(dead_at, id);

CREATE TABLE releases (
	id              TEXT PRIMARY KEY,
	source_id       TEXT NOT NULL REFERENCES sources(id),
	run_id          TEXT NOT NULL,
	commit_sha      TEXT NOT NULL,
	state           TEXT NOT NULL,
	created_at      BIGINT NOT NULL,
	finished_at     BIGINT,
	UNIQUE (source_id, run_id)
);
CREATE TABLE source_maps (
	release_id    TEXT NOT NULL REFERENCES releases(id),
	file_name     TEXT NOT NULL,
	blob_key      TEXT NOT NULL,
	uploaded_at   BIGINT NOT NULL,
	PRIMARY KEY (release_id, file_name)
);

CREATE TABLE health_checks (
	id            TEXT PRIMARY KEY,
	source_id     TEXT NOT NULL REFERENCES sources(id),
	url           TEXT NOT NULL,
	enabled       INTEGER NOT NULL,
	created_at    BIGINT NOT NULL,
	updated_at    BIGINT NOT NULL
);
CREATE TABLE health_observations (
	id            TEXT PRIMARY KEY,
	check_id      TEXT NOT NULL REFERENCES health_checks(id),
	state         TEXT NOT NULL,
	observed_at   BIGINT NOT NULL,
	latency_ms    INTEGER,
	detail_code   TEXT
);
CREATE INDEX idx_health_observations_check_time ON health_observations(check_id, observed_at);
CREATE TABLE current_health (
	check_id      TEXT PRIMARY KEY REFERENCES health_checks(id),
	state         TEXT NOT NULL,
	observed_at   BIGINT NOT NULL,
	latency_ms    INTEGER,
	detail_code   TEXT
);
