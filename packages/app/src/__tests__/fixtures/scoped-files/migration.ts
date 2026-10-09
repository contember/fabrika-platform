// The fixture's migrations, as `db/migrations/` would hold them: the notes, then the collection's table. A note is
// the owner of its files, so it carries the unique key their composite foreign key references.
import { fileTableSql } from '@fabrika/db'

export const migration = `
create table notes (
	id uuid primary key,
	workspace_id text not null,
	title text not null,
	created_by text not null,
	version integer not null,
	unique (id, workspace_id)
);
${fileTableSql('attachments', { table: 'notes', key: { column: 'id', type: 'uuid' }, chain: [{ column: 'workspace_id', type: 'text' }] })}
`
