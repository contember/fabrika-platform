import { defineTables } from '../../tables'
import { columns, derived, vocabulary } from '../derived-tables/schema'

export const tables = defineTables(vocabulary, columns)({
	...derived,
	// mistake: folders has no workspace_id, so its container column must be named
	folders: { scope: { dimension: 'folder' }, actions: { read: 'notes.read' } },
})
