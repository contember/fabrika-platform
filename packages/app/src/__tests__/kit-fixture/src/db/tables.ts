import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	orgs: {
		scope: { dimension: 'org', key: 'id' },
		actions: { read: 'crm.read', insert: 'orgs.create', update: 'members.manage' },
		insert: ['name'],
		update: ['name'],
		version: 'version',
		createdBy: 'created_by',
	},
	companies: {
		scope: { dimension: 'company', key: 'id', in: { dimension: 'org', column: 'org_id' } },
		actions: { read: 'crm.read', insert: 'crm.write', update: 'crm.write', delete: 'crm.delete' },
		insert: ['name'],
		update: ['name'],
		version: 'version',
		createdBy: 'created_by',
	},
	deals: {
		scope: { dimension: 'deal', key: 'id', in: { dimension: 'company', column: 'company_id' } },
		actions: { read: 'crm.read', insert: 'deals.write', update: 'deals.write', delete: 'crm.delete' },
		insert: ['title', 'stage', 'margin'],
		update: ['title', 'stage', 'margin'],
		version: 'version',
		createdBy: 'created_by',
		columns: { margin: { read: 'deals.write' } },
	},
	deal_activities: {
		scope: { child: 'deals', key: 'id', column: 'deal_id', inherit: ['company_id', 'org_id'] },
		actions: { read: 'crm.read', insert: 'deals.write', update: 'deals.write', delete: 'crm.delete' },
		insert: ['body'],
		update: ['body'],
		createdBy: 'created_by',
	},
	countries: {
		scope: { reference: 'ISO 3166 country names' },
		actions: { read: 'crm.read' },
		columns: { note: { read: 'deals.write' } },
	},
})
