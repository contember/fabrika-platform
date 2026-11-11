import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	customers: {
		scope: { dimension: 'customer' },
		actions: { read: 'customers.read', insert: 'customers.write', update: 'customers.write' },
		insert: ['name', 'ico', 'city', 'email'],
		update: ['name', 'city', 'email'],
		version: 'version',
		createdBy: 'created_by',
	},
	customer_reps: {
		scope: { child: 'customers' },
		actions: { read: 'customers.read', insert: 'customers.assign', delete: 'customers.assign' },
		insert: ['principal_id', 'label', 'customer_name', 'customer_city'],
		createdBy: 'created_by',
		confers: {
			handling: { principal: 'principal_id', assign: {} },
		},
	},
	orders: {
		scope: { dimension: 'order' },
		actions: { read: 'orders.read', insert: 'orders.write', update: 'orders.write', delete: 'orders.delete' },
		insert: ['number', 'customer_name', 'title', 'status', 'due_on', 'amount_czk'],
		update: ['status', 'due_on'],
		version: 'version',
		createdBy: 'created_by',
	},
	billing: {
		scope: { child: 'orders' },
		actions: { read: 'billing.read', insert: 'billing.write', update: 'billing.write' },
		insert: ['amount_czk', 'vat_rate', 'status'],
		update: ['status', 'invoice_number'],
		version: 'version',
		createdBy: 'created_by',
	},
})
