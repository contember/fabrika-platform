-- Extend the initial placeholder health tables with portable scheduling and transition state.
ALTER TABLE health_checks ADD COLUMN path TEXT NOT NULL DEFAULT '/health';
ALTER TABLE health_checks ADD COLUMN interval_ms BIGINT NOT NULL DEFAULT 60000;
ALTER TABLE health_checks ADD COLUMN timeout_ms BIGINT NOT NULL DEFAULT 5000;
ALTER TABLE health_checks ADD COLUMN expected_status INTEGER NOT NULL DEFAULT 200;
ALTER TABLE health_checks ADD COLUMN failure_threshold INTEGER NOT NULL DEFAULT 3;
ALTER TABLE health_checks ADD COLUMN recovery_threshold INTEGER NOT NULL DEFAULT 2;
ALTER TABLE health_checks ADD COLUMN stale_after_ms BIGINT NOT NULL DEFAULT 180000;
ALTER TABLE health_checks ADD COLUMN due_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE health_checks ADD COLUMN claimed_until BIGINT;
ALTER TABLE health_checks ADD COLUMN claim_token TEXT;
CREATE INDEX idx_health_checks_due ON health_checks(enabled, due_at, claimed_until);

ALTER TABLE health_observations ADD COLUMN successful INTEGER NOT NULL DEFAULT 0;
ALTER TABLE health_observations ADD COLUMN status_code INTEGER;
ALTER TABLE health_observations ADD COLUMN transition_id TEXT;

ALTER TABLE current_health ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE current_health ADD COLUMN consecutive_successes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE current_health ADD COLUMN transition_id TEXT;

CREATE TABLE health_transitions (
	id          TEXT PRIMARY KEY,
	source_id   TEXT NOT NULL REFERENCES sources(id),
	check_id    TEXT REFERENCES health_checks(id),
	kind        TEXT NOT NULL,
	from_state  TEXT,
	to_state    TEXT NOT NULL,
	occurred_at BIGINT NOT NULL
);
CREATE INDEX idx_health_transitions_source_time ON health_transitions(source_id, occurred_at, id);

CREATE TABLE telemetry_health_observations (
	id          TEXT PRIMARY KEY,
	source_id   TEXT NOT NULL REFERENCES sources(id),
	state       TEXT NOT NULL,
	observed_at BIGINT NOT NULL,
	payload     TEXT NOT NULL,
	transition_id TEXT
);
CREATE INDEX idx_telemetry_health_history ON telemetry_health_observations(source_id, observed_at, id);

CREATE TABLE current_telemetry_health (
	source_id   TEXT PRIMARY KEY REFERENCES sources(id),
	state       TEXT NOT NULL,
	observed_at BIGINT NOT NULL,
	payload     TEXT NOT NULL,
	transition_id TEXT
);
