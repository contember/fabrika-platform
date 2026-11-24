-- ADR-0083: the kinds of change that wait for a person on a protected environment, as their difference from the
-- defaults (`{"added":[…],"removed":[…]}`); NULL is the defaults. Kept with the flag beyond the environment's deletion.
ALTER TABLE app_envs ADD COLUMN approval_categories TEXT;
ALTER TABLE app_env_protection ADD COLUMN approval_categories TEXT;
