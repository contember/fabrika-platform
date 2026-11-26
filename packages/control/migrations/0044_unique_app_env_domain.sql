-- A domain serves one application environment of the whole installation, whatever its namespace or provider, compared
-- case-insensitively. The registry checks it before it writes; this index decides a race between two writes. Partial
-- because an environment without a domain stores NULL (or, from older writes, ''), and because the `dev` environments of
-- several applications may share one wildcard base: each serves only its own workspaces' `<workspace id>.<base>`.
CREATE UNIQUE INDEX idx_app_envs_domain ON app_envs(lower(domain)) WHERE domain IS NOT NULL AND domain <> '' AND kind <> 'dev';
