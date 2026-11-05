import { defineTables } from '../../tables'
import { viewColumns, viewVocabulary } from '../fixtures/view-layer'

export const tables = defineTables(viewVocabulary, viewColumns)({
	organizations: { scope: { dimension: 'organization' }, actions: { read: 'projects.read' } },
	projects: { scope: { dimension: 'project' }, actions: { read: 'projects.read' } },
	events: { scope: { child: 'projects' }, actions: { read: 'projects.read' } },
	project_summaries: {
		scope: { child: 'projects', key: 'project_id' },
		// mistake: a view is read-only, so its policy takes no insert action
		actions: { read: 'projects.read', insert: 'projects.write' },
	},
})
