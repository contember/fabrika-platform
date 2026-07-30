ALTER TABLE sources ADD COLUMN disabled_at INTEGER;
ALTER TABLE sources ADD COLUMN origin TEXT NOT NULL DEFAULT 'control';
ALTER TABLE sources ADD COLUMN public_origin TEXT;

UPDATE sources SET service_key = 'default' WHERE service_key = '';

CREATE TABLE operations_catalog_cursor (
	singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
	revision       INTEGER NOT NULL,
	snapshot_hash  TEXT NOT NULL,
	applied_at     INTEGER NOT NULL
);

INSERT INTO operations_catalog_cursor (singleton, revision, snapshot_hash, applied_at)
VALUES (1, 0, '', 0);
