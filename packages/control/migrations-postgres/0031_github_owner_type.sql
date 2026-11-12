-- Who owns a GitHub source connection's App: an organization, or a personal account (ADR-0029). Every row from before is
-- an organization's, which is all Control connected until now.
ALTER TABLE github_source_setup_attempts
	ADD COLUMN desired_owner_type TEXT NOT NULL DEFAULT 'Organization' CHECK (desired_owner_type IN ('Organization','User'));
ALTER TABLE github_source_connections_keyed
	ADD COLUMN app_owner_type TEXT NOT NULL DEFAULT 'Organization' CHECK (app_owner_type IN ('Organization','User'));
