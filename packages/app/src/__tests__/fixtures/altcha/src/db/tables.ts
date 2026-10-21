import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	applications: {
		scope: { app: 'anonymous registrations before a record exists' },
		actions: { read: 'applications.read', insert: 'applications.submit' },
		insert: ['name', 'email'],
	},
	messages: {
		scope: { app: 'anonymous contact messages' },
		actions: { read: 'messages.read', insert: 'messages.send' },
		insert: ['email', 'body'],
	},
})
