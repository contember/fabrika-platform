-- A workspace's `source` key authenticates nothing once the workspace is gone, so deleting the workspace (with the
-- environment it belongs to) deletes its keys.
ALTER TABLE platform_transport_keys DROP CONSTRAINT platform_transport_keys_workspace_id_fkey;
ALTER TABLE platform_transport_keys ADD CONSTRAINT platform_transport_keys_workspace_id_fkey
	FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE;
