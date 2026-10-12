import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	signups: { scope: { inbox: 'signup', read: 'signups.process' } },
	applications: { scope: { inbox: 'apply', read: 'signups.process' } },
	notices: { scope: { inbox: 'notify', read: 'signups.process' } },
})
