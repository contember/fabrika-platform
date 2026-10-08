-- Contract applications (ADR-0022 rule 6). A row marks an app whose schema was compiled from a
-- contract; IAM then refuses every wildcard action written for it. `putAppSchema` writes it in the
-- same batch as the vocabulary, so the flag and the roles it constrains never disagree.
CREATE TABLE contract_apps (
	app        TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL
);

-- A membership role is granted only in a value of this scope dimension, never globally. NULL for
-- every other role, which is every row written before this file.
ALTER TABLE roles ADD COLUMN member_scope TEXT;
