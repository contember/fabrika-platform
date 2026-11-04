import type { TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import type { ColumnType } from 'kysely'
import { vocabulary } from './vocabulary'

export interface DB {
	projects: { id: string; name: string; version: number }
	tasks: { id: string; project_id: string; open: ColumnType<boolean, boolean | undefined, boolean>; version: number }
	task_assignees: { id: string; task_id: string; project_id: string; principal_id: string }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'name', 'version'], foreignKeys: [] },
	tasks: {
		columns: ['id', 'project_id', 'open', 'version'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		booleans: ['open'],
	},
	task_assignees: {
		columns: ['id', 'task_id', 'project_id', 'principal_id'],
		foreignKeys: [{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] }],
	},
}

export const tables = defineTables(vocabulary, columns)({
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'projects.read', update: 'projects.write' },
		update: ['name'],
		version: 'version',
	},
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read' },
		version: 'version',
		reveals: { assignee: { to: 'project', actions: ['projects.read'], when: { open: { eq: true } } } },
	},
	task_assignees: {
		scope: { child: 'tasks' },
		actions: { read: 'tasks.read', insert: 'tasks.assign', delete: 'tasks.assign' },
		insert: ['principal_id'],
		confers: { assignee: { principal: 'principal_id', assign: {} } },
	},
})
