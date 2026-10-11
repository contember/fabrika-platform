import { defineTables } from '../../tables'
import { columns, derived, vocabulary } from '../derived-tables/schema'

export const tables = defineTables(vocabulary, columns)({
	...derived,
	// mistake: a parent that is a child table, not a dimension table
	note_links: { scope: { child: 'note_comments', column: 'parent_note' }, actions: { read: 'notes.read' } },
})
