import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../kit-fixture/src/vocabulary'

const columns = { orgs: ['id', 'name', 'created_by', 'version'] } as const

// mistake: a hand-written column list carries no row types; the generated one does
export const tables = defineTables(vocabulary, columns)({
	orgs: { scope: { dimension: 'org', key: 'id' }, actions: { read: 'crm.read' } },
})
