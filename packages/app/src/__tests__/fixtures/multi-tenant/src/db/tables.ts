import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns, type DB } from './schema.generated'

export const tables = defineTables<DB, typeof vocabulary>(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write' },
		insert: ['title'],
		update: ['title'],
		version: 'version',
		createdBy: 'created_by',
	},
	contact_messages: { scope: { inbox: 'contact', read: 'contacts.read' } },
})
