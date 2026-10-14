// The fixture's migrations, as `db/migrations/` would hold them: the framework's tables (the jobs' leases), the notes,
// and the table of each collection. A note owns the files of both.
import { fileTableSql } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'

const OWNER = { table: 'notes', key: { column: 'id', type: 'uuid' }, chain: [{ column: 'workspace_id', type: 'text' }] } as const

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
${fileTableSql('documents', OWNER)}
${fileTableSql('attachments', OWNER)}
`
