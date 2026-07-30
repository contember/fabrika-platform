CREATE TABLE operations_release_sync (
	run_id            TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
	desired_revision  INTEGER NOT NULL,
	applied_revision  INTEGER NOT NULL DEFAULT 0,
	payload_json      TEXT NOT NULL,
	last_attempt_at   INTEGER,
	last_success_at   INTEGER,
	last_error        TEXT
);

CREATE INDEX idx_operations_release_sync_pending
	ON operations_release_sync(applied_revision, desired_revision, run_id);
