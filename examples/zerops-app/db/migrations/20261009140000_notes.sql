-- A note lies in a workspace, the scope value IAM grants in; no table owns the workspace itself. The unique key on
-- (id, workspace_id) is what a file's composite foreign key references, so moving a note moves its files.
CREATE TABLE notes (
	id UUID PRIMARY KEY,
	workspace_id TEXT NOT NULL,
	title TEXT NOT NULL,
	trashed BOOLEAN NOT NULL,
	created_by TEXT NOT NULL,
	version INTEGER NOT NULL,
	UNIQUE (id, workspace_id)
);

CREATE INDEX notes_workspace ON notes (workspace_id);

-- The DDL of the `attachments` collection, as `fileTableSql('attachments', { table: 'notes', … })` returns it.
CREATE TABLE fabrika_files_attachments (
	id UUID PRIMARY KEY,
	owner_id UUID,
	workspace_id TEXT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'live')),
	object_key TEXT NOT NULL UNIQUE,
	size BIGINT,
	content_type TEXT NOT NULL,
	sha256 TEXT,
	original_name TEXT,
	created_by TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL,
	deleted_at TIMESTAMPTZ,
	FOREIGN KEY (owner_id, workspace_id) REFERENCES notes (id, workspace_id) ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX fabrika_files_attachments_owner ON fabrika_files_attachments (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX fabrika_files_attachments_removable ON fabrika_files_attachments (created_at) WHERE deleted_at IS NOT NULL OR owner_id IS NULL OR status = 'pending';
