-- The origins an environment lists for its cross-origin endpoints (ADR-0022 "Cross-origin endpoints"): a JSON array of
-- exact origins, set by an operator beside the environment's `domain` and handed to the provider, which writes them into
-- the application's proxy manifest entry. Empty by default, so an existing environment lists none and its proxy answers
-- no preflight, as before.
ALTER TABLE app_envs ADD COLUMN cross_origins_json TEXT NOT NULL DEFAULT '[]';
