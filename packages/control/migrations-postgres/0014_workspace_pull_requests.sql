-- The pull request create_pull_request opened or found for a workspace, so a workspace read names it without asking GitHub.
ALTER TABLE workspaces ADD COLUMN pull_request_number INTEGER;
ALTER TABLE workspaces ADD COLUMN pull_request_url TEXT;
