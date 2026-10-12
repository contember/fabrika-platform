import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note' },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.write' },
		insert: ['title', 'trashed'],
		update: ['title', 'trashed'],
		version: 'version',
		createdBy: 'created_by',
	},
	workspaces: {
		scope: { dimension: 'workspace' },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write' },
		insert: ['name'],
		update: ['name'],
	},
})
