import { defineTables } from '../../tables'
import { viewColumns, viewVocabulary } from '../fixtures/view-layer'

export const tables = defineTables(viewVocabulary, viewColumns)({
	organizations: { scope: { dimension: 'organization' }, actions: { read: 'projects.read' } },
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' } },
	events: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
	project_summaries: {
		scope: { reference: 'every site reads the summaries' },
		actions: { read: 'projects.read' },
		// mistake: a view is read-only, so no column of it takes a write action
		columns: { name: { read: 'projects.read', write: 'projects.write' } },
	},
})
