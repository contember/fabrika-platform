// The fixture's migrations, as `db/migrations/` would hold them: the notes, then the collection's table.
import { fileTableSql } from '@fabrika/db'

export const migration = `
create table notes (
	id uuid primary key,
	workspace_id text not null,
	title text not null,
	created_by text not null,
	version integer not null
);
${fileTableSql('attachments', { table: 'notes', key: 'id', keyType: 'uuid' })}
`
