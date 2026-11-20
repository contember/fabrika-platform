import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	notices: {
		scope: { app: 'notices of the whole board' },
		actions: { read: 'any', insert: ['notices.post', 'intake.submit'] },
		insert: ['body', 'internal'],
		createdBy: 'created_by',
		columns: { internal: { read: 'notices.audit' } },
	},
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.read' },
		insert: ['title'],
		version: 'version',
		createdBy: 'created_by',
	},
})
