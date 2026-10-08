-- While a `namespaces.update` is unconfirmed, the row keeps the target that update was moving to; NULL
-- otherwise. A proxy repair requested meanwhile is recorded and replayed when the update clears (backlog 79).
ALTER TABLE deployment_namespaces ADD COLUMN update_target_json TEXT;
ALTER TABLE deployment_namespaces ADD COLUMN repair_requested INTEGER NOT NULL DEFAULT 0 CHECK (repair_requested IN (0, 1));
