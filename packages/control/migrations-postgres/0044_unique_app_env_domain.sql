-- A domain serves one application environment of the installation, compared without case; this decides a race the
-- registry check lost. A `dev` environment's domain is a wildcard base that several applications' dev environments may
-- share (each serves only `<workspace id>.<base>`), and an environment without a domain stores NULL or ''.
CREATE UNIQUE INDEX idx_app_envs_domain ON app_envs(lower(domain)) WHERE domain IS NOT NULL AND domain <> '' AND kind <> 'dev';
