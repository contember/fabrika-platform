-- Platform-specific app-env targets. Existing rows remain Cloudflare targets.
ALTER TABLE app_envs ADD COLUMN platform TEXT NOT NULL DEFAULT 'cloudflare'
	CHECK (platform IN ('cloudflare', 'zerops'));
ALTER TABLE app_envs ADD COLUMN zerops_project_id TEXT;
ALTER TABLE app_envs ADD COLUMN zerops_service_id TEXT;
ALTER TABLE app_envs ADD COLUMN manifest_json TEXT;

-- Zerops owns the asynchronous work. Its application-version id survives process restarts.
ALTER TABLE runs ADD COLUMN platform_run_id TEXT;
