import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	unsubscribes: {
		scope: { app: 'a recipient opts out of a campaign' },
		actions: { read: 'mail.read', insert: 'mailing.unsubscribe' },
		insert: ['email', 'campaign'],
		createdBy: 'created_by',
	},
	bookings: {
		scope: { app: 'anyone books a slot' },
		actions: { read: 'mail.read', insert: 'bookings.book', update: 'bookings.manage', delete: 'bookings.manage' },
		insert: ['name', 'slot'],
		update: ['slot'],
		version: 'version',
		createdBy: 'created_by',
	},
	clicks: {
		scope: { app: 'campaign statistics' },
		actions: { read: 'mail.read', insert: 'stats.click' },
		insert: ['campaign'],
		createdBy: 'created_by',
	},
})
