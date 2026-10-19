// The fixture's migrations, as `db/migrations/` would hold them: the framework's tables (the jobs' leases and the
// stored files), the notes, and a table per file column. A note holds the rows of both.
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'

export const migration = `
${FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')}
create table notes (
	id uuid primary key,
	workspace_id text not null,
	title text not null,
	created_by text not null,
	version integer not null,
	unique (id, workspace_id)
);
create table note_documents (
	id uuid primary key,
	note_id uuid not null,
	workspace_id text not null,
	file uuid not null references fabrika_files (id),
	foreign key (note_id, workspace_id) references notes (id, workspace_id)
);
create index note_documents_file on note_documents (file);
create table note_attachments (
	id uuid primary key,
	note_id uuid not null,
	workspace_id text not null,
	file uuid not null references fabrika_files (id),
	foreign key (note_id, workspace_id) references notes (id, workspace_id)
);
create index note_attachments_file on note_attachments (file);
`
