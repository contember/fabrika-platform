import type { TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from './vocabulary'

export interface DB {
	orgs: { id: string; name: string }
	projects: { id: string; org_id: string; name: string }
	project_members: { id: string; project_id: string; org_id: string; principal_id: string }
	tasks: { id: string; project_id: string; org_id: string; visibility: string; title: string }
}

export const columns: TypedColumnList<DB> = {
	orgs: { columns: ['id', 'name'], foreignKeys: [], notNull: ['id', 'name'] },
	projects: {
		columns: ['id', 'org_id', 'name'],
		foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }],
		notNull: ['id', 'org_id', 'name'],
	},
	project_members: {
		columns: ['id', 'project_id', 'org_id', 'principal_id'],
		foreignKeys: [{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }],
		notNull: ['id', 'project_id', 'org_id', 'principal_id'],
	},
	tasks: {
		columns: ['id', 'project_id', 'org_id', 'visibility', 'title'],
		foreignKeys: [{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] }],
		notNull: ['id', 'project_id', 'org_id', 'visibility', 'title'],
	},
}

export const policies = {
	orgs: { scope: { dimension: 'org' }, actions: { read: 'tasks.read' } },
	projects: { scope: { dimension: 'project' }, actions: { read: 'tasks.read' } },
	project_members: {
		scope: { child: 'projects' },
		actions: { read: 'tasks.read', insert: 'members.assign' },
		insert: ['principal_id'],
		confers: { member: { principal: 'principal_id', assign: {} } },
	},
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read' },
		admits: { 'tasks.read': { visibility: { eq: 'public' } } },
	},
} as const

export const tables = defineTables(vocabulary, columns)(policies)
