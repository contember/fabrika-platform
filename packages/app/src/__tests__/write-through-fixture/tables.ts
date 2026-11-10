import type { TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from './vocabulary'

export interface DB {
	teams: { id: string }
	team_members: { id: string; team_id: string; principal_id: string }
	projects: { id: string; name: string; version: number }
	tasks: { id: string; project_id: string; team_id: string | null; title: string; version: number }
}

const columns: TypedColumnList<DB> = {
	teams: { columns: ['id'], foreignKeys: [] },
	team_members: { columns: ['id', 'team_id', 'principal_id'], foreignKeys: [{ columns: ['team_id'], table: 'teams', references: ['id'] }] },
	projects: { columns: ['id', 'name', 'version'], foreignKeys: [] },
	tasks: {
		columns: ['id', 'project_id', 'team_id', 'title', 'version'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }, { columns: ['team_id'], table: 'teams', references: ['id'] }],
	},
}

export const tables = defineTables(vocabulary, columns)({
	teams: { scope: { dimension: 'team' }, actions: { read: 'teams.read' } },
	team_members: { scope: { child: 'teams' }, actions: { read: 'teams.read' }, confers: { teamMember: { principal: 'principal_id' } } },
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'projects.read', update: 'projects.rename' },
		update: ['name'],
		version: 'version',
	},
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read', insert: 'tasks.insert', update: 'tasks.write' },
		insert: ['title', 'team_id'],
		update: ['title'],
		version: 'version',
		readThrough: { team: 'team_id' },
		writeThrough: { team: ['tasks.read', 'tasks.write', 'projects.rename'] },
		reveals: { teamMember: { to: 'project', actions: ['projects.rename'], assign: { self: true } } },
		memberReveals: { team: { to: 'project', actions: ['projects.read'], assign: {} } },
	},
})
