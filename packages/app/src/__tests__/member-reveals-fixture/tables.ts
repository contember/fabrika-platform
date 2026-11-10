import type { TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import type { ColumnType } from 'kysely'
import { vocabulary } from './vocabulary'

export interface DB {
	projects: { id: string; name: string; version: number }
	tasks: { id: string; project_id: string; version: number }
	steps: { id: string; task_id: string; project_id: string; open: ColumnType<boolean, boolean | undefined, boolean>; version: number }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'name', 'version'], foreignKeys: [] },
	tasks: { columns: ['id', 'project_id', 'version'], foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }] },
	steps: {
		columns: ['id', 'task_id', 'project_id', 'open', 'version'],
		foreignKeys: [{ columns: ['task_id', 'project_id'], table: 'tasks', references: ['id', 'project_id'] }],
		booleans: ['open'],
	},
}

export const tables = defineTables(vocabulary, columns)({
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'projects.read', update: 'projects.rename' },
		update: ['name'],
		version: 'version',
	},
	tasks: { scope: { dimension: 'task' }, actions: { read: 'steps.read' }, version: 'version' },
	steps: {
		scope: { dimension: 'step' },
		actions: { read: 'steps.read' },
		version: 'version',
		memberReveals: { step: { to: 'project', actions: ['projects.read', 'projects.rename'], when: { open: { eq: true } } } },
	},
})
