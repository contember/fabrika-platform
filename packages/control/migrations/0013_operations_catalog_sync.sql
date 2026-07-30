CREATE TABLE operations_catalog_sync (
	singleton             INTEGER PRIMARY KEY CHECK (singleton = 1),
	desired_revision      INTEGER NOT NULL,
	applied_revision      INTEGER NOT NULL,
	attempted_revision    INTEGER,
	last_snapshot_hash    TEXT NOT NULL,
	applied_snapshot_hash TEXT NOT NULL,
	last_attempt_at       INTEGER,
	last_success_at       INTEGER,
	last_error            TEXT
);

INSERT INTO operations_catalog_sync (
	singleton, desired_revision, applied_revision, last_snapshot_hash, applied_snapshot_hash
)
VALUES (1, 0, 0, '', '');
