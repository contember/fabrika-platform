import { defineTables } from '../../tables'
import { columns, derived, vocabulary } from '../derived-tables/schema'

export const tables = defineTables(vocabulary, columns)({
	...derived,
	// mistake: note_links has no note_id, so its column for the parent must be named
	note_links: { scope: { child: 'notes' }, actions: { read: 'notes.read' } },
})
