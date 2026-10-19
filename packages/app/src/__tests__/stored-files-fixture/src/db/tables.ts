import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	deals: { scope: { dimension: 'deal' }, actions: { read: 'crm.read', insert: 'deals.write' }, insert: ['name'] },
	deal_attachments: {
		scope: { child: 'deals' },
		actions: { read: 'crm.read', insert: 'deals.write' },
		insert: ['file', 'name'],
		files: { file: 'attachments' },
	},
	products: {
		scope: { app: 'one catalog per application' },
		actions: { read: ['catalog.read', 'catalog.write'], insert: 'catalog.write', update: 'catalog.write' },
		insert: ['name', 'image'],
		update: ['name', 'image'],
		files: { image: 'catalog' },
		version: 'version',
	},
	submissions: {
		scope: { app: 'anonymous intake before a record exists' },
		actions: { read: 'intake.drain', insert: 'intake.register', delete: 'intake.drain' },
		insert: ['name', 'photo'],
		files: { photo: 'photos' },
	},
})
