import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	outbox: {
		scope: { app: 'the messages the deliver job sends' },
		actions: { read: 'outbox.read', insert: 'outbox.write' },
		insert: ['body'],
	},
})
