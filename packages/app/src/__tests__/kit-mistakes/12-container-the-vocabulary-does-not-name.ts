import { defineTables } from '@fabrika/db/tables'
import { columns } from '../kit-fixture/src/db/schema.generated'
import { vocabulary } from '../kit-fixture/src/vocabulary'

export const tables = defineTables(vocabulary, columns)({
	orgs: { scope: { dimension: 'org' }, actions: { read: 'crm.read' } },
	companies: { scope: { dimension: 'company' }, actions: { read: 'crm.read' } },
	// mistake: the vocabulary puts a deal in a company, not in an org
	deals: { scope: { dimension: 'deal', in: { dimension: 'org', column: 'org_id' } }, actions: { read: 'crm.read' } },
	deal_activities: { scope: { child: 'deals' }, actions: { read: 'crm.read' } },
	countries: { scope: { reference: 'ISO 3166 country names' }, actions: { read: 'crm.read' } },
})
