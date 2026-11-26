-- ADR-0083: `role-external`, `public` and `csp` wait for a person by default from this release. Both columns store a
-- choice as its difference from the defaults, so an environment that saved one kept these three `off` by leaving them
-- out; they are written out as `off` here. An environment that saved no choice (both NULL) takes the new defaults.

UPDATE app_envs SET approval_categories = jsonb_set(COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb, '{removed}', (COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') || '["role-external"]'::jsonb)::text
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'added') @> '["role-external"]'::jsonb)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') @> '["role-external"]'::jsonb);
UPDATE app_envs SET approval_policy = jsonb_set(approval_policy::jsonb, '{role-external}', '"off"'::jsonb)::text
WHERE approval_policy IS NOT NULL AND (approval_policy::jsonb -> 'role-external') IS NULL;

UPDATE app_envs SET approval_categories = jsonb_set(COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb, '{removed}', (COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') || '["public"]'::jsonb)::text
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'added') @> '["public"]'::jsonb)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') @> '["public"]'::jsonb);
UPDATE app_envs SET approval_policy = jsonb_set(approval_policy::jsonb, '{public}', '"off"'::jsonb)::text
WHERE approval_policy IS NOT NULL AND (approval_policy::jsonb -> 'public') IS NULL;

UPDATE app_envs SET approval_categories = jsonb_set(COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb, '{removed}', (COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') || '["csp"]'::jsonb)::text
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'added') @> '["csp"]'::jsonb)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') @> '["csp"]'::jsonb);
UPDATE app_envs SET approval_policy = jsonb_set(approval_policy::jsonb, '{csp}', '"off"'::jsonb)::text
WHERE approval_policy IS NOT NULL AND (approval_policy::jsonb -> 'csp') IS NULL;

UPDATE app_env_protection SET approval_categories = jsonb_set(COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb, '{removed}', (COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') || '["role-external"]'::jsonb)::text
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'added') @> '["role-external"]'::jsonb)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') @> '["role-external"]'::jsonb);
UPDATE app_env_protection SET approval_policy = jsonb_set(approval_policy::jsonb, '{role-external}', '"off"'::jsonb)::text
WHERE approval_policy IS NOT NULL AND (approval_policy::jsonb -> 'role-external') IS NULL;

UPDATE app_env_protection SET approval_categories = jsonb_set(COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb, '{removed}', (COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') || '["public"]'::jsonb)::text
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'added') @> '["public"]'::jsonb)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') @> '["public"]'::jsonb);
UPDATE app_env_protection SET approval_policy = jsonb_set(approval_policy::jsonb, '{public}', '"off"'::jsonb)::text
WHERE approval_policy IS NOT NULL AND (approval_policy::jsonb -> 'public') IS NULL;

UPDATE app_env_protection SET approval_categories = jsonb_set(COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb, '{removed}', (COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') || '["csp"]'::jsonb)::text
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'added') @> '["csp"]'::jsonb)
	AND NOT ((COALESCE(approval_categories, '{"added":[],"removed":[]}')::jsonb -> 'removed') @> '["csp"]'::jsonb);
UPDATE app_env_protection SET approval_policy = jsonb_set(approval_policy::jsonb, '{csp}', '"off"'::jsonb)::text
WHERE approval_policy IS NOT NULL AND (approval_policy::jsonb -> 'csp') IS NULL;
