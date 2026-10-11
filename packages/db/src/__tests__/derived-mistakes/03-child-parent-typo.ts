import { defineTables } from '../../tables'
import { columns, derived, vocabulary } from '../derived-tables/schema'

export const tables = defineTables(vocabulary, columns)({
	...derived,
	// mistake: a parent that is not a table
	note_comments: { scope: { child: 'nots' }, actions: { read: 'notes.read' } },
})
