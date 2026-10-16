-- Postgres twin of ../migrations/0010_cross_origins.sql; see that file for the model. The outcome is identical.
ALTER TABLE app_envs ADD COLUMN cross_origins_json TEXT NOT NULL DEFAULT '[]';
