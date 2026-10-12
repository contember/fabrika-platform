import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	orgs: {
		scope: { dimension: 'org', key: 'id' },
		actions: { read: 'crm.read' },
	},
	companies: {
		scope: { dimension: 'company', key: 'id', in: { dimension: 'org', column: 'org_id' } },
		actions: { read: 'crm.read' },
	},
	deals: {
		scope: { dimension: 'deal', key: 'id', in: { dimension: 'company', column: 'company_id' } },
		actions: { read: 'crm.read', insert: 'deals.write', update: 'deals.write' },
		insert: ['title'],
		update: ['title'],
		version: 'version',
		createdBy: 'created_by',
		columns: { owner: { write: 'deals.assign' }, owner_label: { write: 'deals.assign' } },
	},
})
