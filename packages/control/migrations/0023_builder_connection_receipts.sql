CREATE TABLE builder_connection_receipts (
	attempt_id TEXT PRIMARY KEY,
	app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
	creator_id TEXT NOT NULL,
	request_key TEXT NOT NULL,
	receipt_json TEXT NOT NULL
);
CREATE INDEX builder_connection_receipts_app ON builder_connection_receipts(app_id);
