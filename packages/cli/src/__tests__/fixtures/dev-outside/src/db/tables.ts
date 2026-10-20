import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	requests: {
		scope: { app: 'a sign-up arrives before anyone has an account' },
		actions: { read: 'signups.process', insert: 'signups.join' },
		insert: ['email'],
	},
})
