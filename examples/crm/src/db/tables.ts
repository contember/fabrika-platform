import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	companies: {
		scope: { dimension: 'company' },
		actions: { read: 'crm.read', insert: 'crm.write', update: 'crm.write', delete: 'crm.delete' },
		insert: ['name', 'website'],
		update: ['name', 'website'],
		version: 'version',
		createdBy: 'created_by',
	},
	contacts: {
		scope: { dimension: 'contact' },
		actions: { read: 'crm.read', insert: 'crm.write', update: 'crm.write', delete: 'crm.delete' },
		insert: ['name', 'email', 'phone'],
		update: ['name', 'email', 'phone'],
		version: 'version',
		createdBy: 'created_by',
	},
	deals: {
		scope: { dimension: 'deal' },
		actions: { read: 'crm.read', insert: 'deals.write', update: 'deals.write', delete: 'crm.delete' },
		insert: ['title', 'value', 'stage', 'source', 'owner', 'owner_label'],
		update: ['title', 'value', 'stage', 'source'],
		version: 'version',
		createdBy: 'created_by',
		columns: { owner: { write: 'deals.assign' }, owner_label: { write: 'deals.assign' } },
	},
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'crm.read', insert: 'tasks.write', update: 'tasks.write' },
		insert: ['title', 'due_on', 'assignee', 'assignee_label'],
		update: ['done', 'overdue'],
		version: 'version',
		createdBy: 'created_by',
	},
	contact_activities: {
		scope: { child: 'contacts' },
		actions: { read: 'crm.read', insert: 'activities.write' },
		insert: ['kind', 'body', 'author_label'],
		createdBy: 'created_by',
	},
	deal_activities: {
		scope: { child: 'deals' },
		actions: { read: 'crm.read', insert: 'activities.write' },
		insert: ['kind', 'body', 'author_label'],
		createdBy: 'created_by',
	},
	deal_attachments: {
		scope: { child: 'deals' },
		actions: { read: 'crm.read', insert: 'deals.write', delete: 'crm.delete' },
		insert: ['file', 'name'],
		files: { file: 'attachments' },
		createdBy: 'created_by',
	},
})
