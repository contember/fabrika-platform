import { defineTables } from '../../tables'
import { columns, derived, vocabulary } from '../derived-tables/schema'

export const tables = defineTables(vocabulary, columns)({
	...derived,
	// mistake: a container column the table does not have
	folders: { scope: { dimension: 'folder', in: { column: 'spaceid' } }, actions: { read: 'notes.read' } },
})
