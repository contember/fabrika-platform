import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.delete' },
		insert: ['title'],
		update: ['title'],
		version: 'version',
		createdBy: 'created_by',
	},
	note_documents: {
		scope: { child: 'notes' },
		actions: { read: 'notes.read', insert: 'notes.write', delete: 'notes.delete' },
		insert: ['file'],
		files: { file: 'documents' },
	},
	note_attachments: {
		scope: { child: 'notes' },
		actions: { read: 'notes.read', insert: 'notes.write', delete: 'notes.delete' },
		insert: ['file'],
		files: { file: 'attachments' },
	},
})
