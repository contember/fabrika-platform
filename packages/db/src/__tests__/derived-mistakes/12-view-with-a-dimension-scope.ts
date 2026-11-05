import { defineTables } from '../../tables'
import { viewColumns, viewVocabulary } from '../fixtures/view-layer'

export const tables = defineTables(viewVocabulary, viewColumns)({
	organizations: { scope: { dimension: 'organization' }, actions: { read: 'projects.read' } },
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' } },
	events: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
	project_summaries: {
		// mistake: a view takes a child or a reference scope; a dimension table's rows are written
		scope: { dimension: 'project', key: 'project_id' },
		actions: { read: 'projects.read' },
	},
})
