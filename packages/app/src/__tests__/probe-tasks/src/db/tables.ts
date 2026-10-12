import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'tasks.read', insert: 'tasks.write' },
		insert: ['title'],
	},
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write' },
		insert: ['title', 'status', 'due_on'],
		update: ['title', 'status', 'due_on', 'closed_at', 'overdue'],
		version: 'version',
		createdBy: 'created_by',
		columns: { assignee: { write: 'tasks.assign' } },
	},
})
