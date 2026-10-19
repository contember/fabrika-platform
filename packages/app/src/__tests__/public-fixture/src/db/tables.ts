import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	submissions: {
		scope: { app: 'anonymous intake before a record exists' },
		actions: { read: 'intake.read', insert: 'intake.register' },
		insert: ['name', 'client_ip', 'user_agent'],
		createdBy: 'created_by',
	},
	products: {
		scope: { app: 'one catalog per application' },
		actions: { read: ['intake.read', 'catalog.read'], insert: 'catalog.write' },
		insert: ['name'],
		createdBy: 'created_by',
	},
})
