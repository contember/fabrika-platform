import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
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
