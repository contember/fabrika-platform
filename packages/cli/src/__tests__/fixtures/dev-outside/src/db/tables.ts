import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	requests: { scope: { inbox: 'join', read: 'signups.process' } },
})
