import { defineTables } from '@fabrika/db/tables'
import { columns, type DB } from './schema.generated'

export const tables = defineTables<DB, 'notes.read' | 'notes.write'>(columns)({
	workspaces: {
		scope: { dimension: 'workspace', key: 'id', in: { dimension: 'organization', column: 'organization_id' } },
		actions: { read: 'notes.read' },
	},
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write' },
		insert: ['title'],
	},
})
