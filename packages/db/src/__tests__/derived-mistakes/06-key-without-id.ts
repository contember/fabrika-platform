import { defineTables } from '../../tables'
import { columns, derived, vocabulary } from '../derived-tables/schema'

export const tables = defineTables(vocabulary, columns)({
	...derived,
	// mistake: tags has no id column, so its key must be named
	tags: { scope: { dimension: 'tag' }, actions: { read: 'notes.read' } },
})
