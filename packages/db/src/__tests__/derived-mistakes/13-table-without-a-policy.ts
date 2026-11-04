import { defineTables } from '../../tables'
import { viewColumns, viewVocabulary } from '../fixtures/view-layer'

// mistake: a view needs no policy, but every table does: events has none
export const tables = defineTables(viewVocabulary, viewColumns)({
	organizations: { scope: { dimension: 'organization' }, actions: { read: 'projects.read' } },
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' } },
})
