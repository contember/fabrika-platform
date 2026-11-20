import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	desks: {
		scope: { app: 'the cash desks of every branch' },
		actions: { read: ['cash.read', 'cash.audit', 'cash.manage'], insert: 'cash.manage', update: 'cash.manage' },
		insert: ['label', 'status', 'audit_note'],
		update: ['status'],
		version: 'version',
		createdBy: 'created_by',
		columns: { audit_note: { read: 'cash.audit' } },
		when: { 'cash.read': { status: { eq: 'open' } }, 'cash.audit': { status: { eq: 'closed' } } },
	},
	entries: {
		scope: { app: 'the cash entries of every desk' },
		actions: { read: 'cash.manage', insert: 'cash.manage' },
		insert: ['desk_id', 'amount'],
		createdBy: 'created_by',
	},
})
