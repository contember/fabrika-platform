import { defineTables } from '../../tables'
import { columns, derived, vocabulary } from '../derived-tables/schema'

export const tables = defineTables(vocabulary, columns)({
	...derived,
	// mistake: a dimension the vocabulary does not declare
	workspaces: { scope: { dimension: 'workspce' }, actions: { read: 'notes.read' } },
})
