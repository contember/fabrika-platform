-- ADR-0083 §2: the mode per category (off, plan, person, refuse) that differs from the defaults, as a JSON object; NULL is
-- the defaults. Written beside `approval_categories`, which keeps its meaning for a Control released before it. Kept with
-- the flag beyond the environment's deletion.
ALTER TABLE app_envs ADD COLUMN approval_policy TEXT;
ALTER TABLE app_env_protection ADD COLUMN approval_policy TEXT;
