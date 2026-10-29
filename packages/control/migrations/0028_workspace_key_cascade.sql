-- A workspace's `source` key authenticates nothing once the workspace is gone, so deleting the workspace (with the
-- environment it belongs to) deletes its keys. SQLite cannot change a foreign key, so the table is rebuilt; nothing
-- references it.
CREATE TABLE platform_transport_keys_rebuilt (
	app_id       TEXT NOT NULL,
	env          TEXT NOT NULL,
	receiver     TEXT NOT NULL,
	key_id       TEXT NOT NULL,
	key_hash     TEXT NOT NULL UNIQUE,
	value_ref    TEXT NOT NULL,
	expires_at   INTEGER NOT NULL,
	created_at   INTEGER NOT NULL,
	workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
	PRIMARY KEY (app_id, env, receiver, key_id),
	FOREIGN KEY (app_id, env) REFERENCES app_envs(app_id, env) ON DELETE CASCADE
);
INSERT INTO platform_transport_keys_rebuilt (app_id, env, receiver, key_id, key_hash, value_ref, expires_at, created_at, workspace_id)
	SELECT app_id, env, receiver, key_id, key_hash, value_ref, expires_at, created_at, workspace_id FROM platform_transport_keys;
DROP TABLE platform_transport_keys;
ALTER TABLE platform_transport_keys_rebuilt RENAME TO platform_transport_keys;
