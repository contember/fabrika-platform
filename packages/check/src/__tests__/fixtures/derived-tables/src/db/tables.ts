// Every key, container and child chain is derived: `projects` on the `<container>_id` convention, `tasks` off it
// (`in: { column }`), and `task_comments` takes its column and chain from its parent.

import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	orgs: { scope: { dimension: 'org' }, actions: { read: 'tasks.read' } },
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'tasks.read', insert: 'tasks.write', update: 'tasks.write' },
		insert: ['name'],
		update: ['name'],
		version: 'version',
	},
	tasks: {
		scope: { dimension: 'task', in: { column: 'parent_project' } },
		actions: { read: 'tasks.read', insert: 'tasks.write' },
		insert: ['title'],
	},
	task_comments: {
		scope: { child: 'tasks' },
		actions: { read: 'tasks.read', insert: 'tasks.write' },
		insert: ['body'],
	},
})
