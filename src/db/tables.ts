import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'project', column: 'project_id' } },
		actions: { read: 'example.read', insert: 'example.write', update: 'example.write' },
		insert: ['title', 'attachment'],
		update: ['reviewed_at'],
		files: { attachment: 'attachments' },
		version: 'version',
		createdBy: 'created_by',
	},
})
