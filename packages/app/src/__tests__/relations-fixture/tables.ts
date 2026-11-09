import type { TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import type { ColumnType } from 'kysely'
import { vocabulary } from './vocabulary'

export interface DB {
	projects: { id: string; name: string; archived: ColumnType<boolean, boolean | undefined, boolean>; version: number }
	project_members: {
		id: string
		project_id: string
		principal_id: string
		expires_at: ColumnType<Date | null, Date | string | null, Date | string | null>
	}
	people: { id: string; principal_id: string }
	project_staff: { id: string; project_id: string; person_id: string }
}

const columns: TypedColumnList<DB> = {
	projects: { columns: ['id', 'name', 'archived', 'version'], foreignKeys: [], booleans: ['archived'] },
	project_members: {
		columns: ['id', 'project_id', 'principal_id', 'expires_at'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }],
		timestamps: ['expires_at'],
	},
	people: { columns: ['id', 'principal_id'], foreignKeys: [] },
	project_staff: {
		columns: ['id', 'project_id', 'person_id'],
		foreignKeys: [{ columns: ['project_id'], table: 'projects', references: ['id'] }, { columns: ['person_id'], table: 'people', references: ['id'] }],
	},
}

export const tables = defineTables(vocabulary, columns)({
	projects: {
		scope: { dimension: 'project' },
		actions: { read: 'projects.read', update: 'projects.write' },
		update: ['name'],
		version: 'version',
		when: { 'projects.write': { archived: { eq: false } } },
	},
	project_members: {
		scope: { child: 'projects' },
		actions: { read: 'projects.read', insert: 'members.assign', delete: 'members.assign' },
		insert: ['principal_id', 'expires_at'],
		confers: { member: { principal: 'principal_id', expires: 'expires_at', assign: { maxDays: 30 } } },
	},
	people: { scope: { app: 'the directory a staff row names its person from' }, actions: { read: 'projects.read' } },
	project_staff: {
		scope: { child: 'projects' },
		actions: { read: 'projects.read', insert: 'staff.assign' },
		insert: ['person_id'],
		confers: { staff: { principal: 'person_id.principal_id', assign: {} } },
	},
})
