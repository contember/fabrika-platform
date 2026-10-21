-- When the owner abandoned the workspace through delete_workspace; its branch is deleted then, and the row is kept so
-- the runs of that branch still resolve to their workspace.
ALTER TABLE workspaces ADD COLUMN abandoned_at INTEGER;
