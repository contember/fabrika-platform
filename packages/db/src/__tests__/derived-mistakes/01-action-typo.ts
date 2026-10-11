import { defineTables } from '../../tables'
import { columns, derived, vocabulary } from '../derived-tables/schema'

export const tables = defineTables(vocabulary, columns)({
	...derived,
	// mistake: an action the vocabulary does not declare
	workspaces: { scope: { dimension: 'workspace' }, actions: { read: 'notes.raed' } },
})
