import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	cards: {
		scope: { dimension: 'card' },
		actions: { read: 'cards.read', insert: 'cards.write' },
		insert: ['title'],
		createdBy: 'created_by',
	},
})
