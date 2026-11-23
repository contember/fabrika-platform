-- An environment Control took offline (`apps.environments.suspend`): when, and on Cloudflare the maintenance mode its
-- object was in before, which `resume` restores. NULL `suspended_at` serves; a Zerops suspension records no mode.
ALTER TABLE app_envs ADD COLUMN suspended_at INTEGER;
ALTER TABLE app_envs ADD COLUMN suspended_from_mode TEXT CHECK (suspended_from_mode IN ('open','read-only'));
