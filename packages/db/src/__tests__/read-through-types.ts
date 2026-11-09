// A table's `readThrough` dimension lists it in the type-level `within`, as the runtime handle does: tsc fails when
// the two drift.

import { type DbIndex, defineTables, type Tables, type TypedColumnList, type WithinTables } from '../tables'

interface DB {
	orgs: { id: string }
	projects: { id: string; org_id: string }
	teams: { id: string; org_id: string }
	tasks: { id: string; project_id: string; org_id: string; team_id: string | null; title: string }
}

const columns: TypedColumnList<DB> = {
	orgs: { columns: ['id'], foreignKeys: [], notNull: ['id'] },
	projects: { columns: ['id', 'org_id'], foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }], notNull: ['id', 'org_id'] },
	teams: { columns: ['id', 'org_id'], foreignKeys: [{ columns: ['org_id'], table: 'orgs', references: ['id'] }], notNull: ['id', 'org_id'] },
	tasks: {
		columns: ['id', 'project_id', 'org_id', 'team_id', 'title'],
		foreignKeys: [
			{ columns: ['project_id', 'org_id'], table: 'projects', references: ['id', 'org_id'] },
			{ columns: ['team_id', 'org_id'], table: 'teams', references: ['id', 'org_id'] },
		],
		notNull: ['id', 'project_id', 'org_id', 'title'],
	},
}

const vocabulary = {
	app: 'read-through-types',
	dimensions: { org: {}, project: { in: 'org' }, team: { in: 'org' } },
	actions: { 'tasks.read': 'Read tasks', 'teams.read': 'Read teams' },
	roles: {},
} as const

export const readThroughTables = defineTables(vocabulary, columns)({
	orgs: { scope: { dimension: 'org' }, actions: { read: 'teams.read' } },
	projects: { scope: { dimension: 'project' }, actions: { read: 'tasks.read' } },
	teams: { scope: { dimension: 'team' }, actions: { read: 'teams.read' } },
	tasks: { scope: { child: 'projects' }, actions: { read: 'tasks.read' }, readThrough: { team: 'team_id' } },
})

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type Policies = typeof readThroughTables extends Tables<DB, infer P> ? P : never
type Index = DbIndex<DB, Policies, typeof vocabulary>

export type ReadThroughTypes = [
	// A `Within` of `team` lists the tasks it reads through `team_id`; without `readThrough` it would list none.
	Expect<Equal<keyof WithinTables<Index, 'team', 'tasks.read', 'query'>, 'tasks'>>,
	// A `Within` of `project` lists its contained tasks, as before.
	Expect<Equal<keyof WithinTables<Index, 'project', 'tasks.read', 'query'>, 'tasks'>>,
]
