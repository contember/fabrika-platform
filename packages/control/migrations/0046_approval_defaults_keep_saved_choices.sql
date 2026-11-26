-- ADR-0083: `role-external`, `public` and `csp` wait for a person by default from this release. Both columns store a
-- choice as its difference from the defaults, so an environment that saved one kept these three `off` by leaving them
-- out; they are written out as `off` here. An environment that saved no choice (both NULL) takes the new defaults.

UPDATE app_envs SET approval_categories = json_set(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed[#]', 'role-external')
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.added') WHERE value = 'role-external')
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed') WHERE value = 'role-external');
UPDATE app_envs SET approval_policy = json_set(approval_policy, '$."role-external"', 'off')
WHERE approval_policy IS NOT NULL AND json_extract(approval_policy, '$."role-external"') IS NULL;

UPDATE app_envs SET approval_categories = json_set(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed[#]', 'public')
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.added') WHERE value = 'public')
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed') WHERE value = 'public');
UPDATE app_envs SET approval_policy = json_set(approval_policy, '$."public"', 'off')
WHERE approval_policy IS NOT NULL AND json_extract(approval_policy, '$."public"') IS NULL;

UPDATE app_envs SET approval_categories = json_set(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed[#]', 'csp')
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.added') WHERE value = 'csp')
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed') WHERE value = 'csp');
UPDATE app_envs SET approval_policy = json_set(approval_policy, '$."csp"', 'off')
WHERE approval_policy IS NOT NULL AND json_extract(approval_policy, '$."csp"') IS NULL;

UPDATE app_env_protection SET approval_categories = json_set(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed[#]', 'role-external')
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.added') WHERE value = 'role-external')
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed') WHERE value = 'role-external');
UPDATE app_env_protection SET approval_policy = json_set(approval_policy, '$."role-external"', 'off')
WHERE approval_policy IS NOT NULL AND json_extract(approval_policy, '$."role-external"') IS NULL;

UPDATE app_env_protection SET approval_categories = json_set(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed[#]', 'public')
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.added') WHERE value = 'public')
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed') WHERE value = 'public');
UPDATE app_env_protection SET approval_policy = json_set(approval_policy, '$."public"', 'off')
WHERE approval_policy IS NOT NULL AND json_extract(approval_policy, '$."public"') IS NULL;

UPDATE app_env_protection SET approval_categories = json_set(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed[#]', 'csp')
WHERE (approval_categories IS NOT NULL OR approval_policy IS NOT NULL)
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.added') WHERE value = 'csp')
	AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(approval_categories, '{"added":[],"removed":[]}'), '$.removed') WHERE value = 'csp');
UPDATE app_env_protection SET approval_policy = json_set(approval_policy, '$."csp"', 'off')
WHERE approval_policy IS NOT NULL AND json_extract(approval_policy, '$."csp"') IS NULL;
