// Sparse ownership: the vocabulary puts a task in a workspace and a workspace in an org, and only `tasks` is a table.
// The layer's chain for a task is workspace_id, org_id, so the indexed types follow the vocabulary past the dimensions
// no table owns: an `over` of the org lists tasks, and an unscoped insert names both containment columns.

import { defineTables } from '../policy'
import type { DbIndex, Tables, UnscopedInsert, WithinTables } from '../tables'
import type { TypedColumnList } from '../vocabulary-tables'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

interface DB {
	tasks: { id: string; workspace_id: string; org_id: string; title: string }
}

const columns: TypedColumnList<DB> = { tasks: { columns: ['id', 'workspace_id', 'org_id', 'title'], foreignKeys: [] } }

const vocabulary = {
	app: 'sparse',
	dimensions: { org: {}, workspace: { in: 'org' }, task: { in: 'workspace' } },
	actions: { 'tasks.read': 'Read tasks', 'tasks.write': 'Write tasks' },
	roles: {},
} as const

export const sparse = defineTables(vocabulary, columns)({
	tasks: { scope: { dimension: 'task' }, actions: { read: 'tasks.read', insert: 'tasks.write' }, insert: ['title'] },
})

type Policies = typeof sparse extends Tables<DB, infer P> ? P : never
type Index = DbIndex<DB, Policies, typeof vocabulary>

export type SparseTypes = [
	Expect<Equal<keyof WithinTables<Index, 'org', 'tasks.read', 'query'>, 'tasks'>>,
	Expect<Equal<keyof WithinTables<Index, 'workspace', 'tasks.read', 'query'>, 'tasks'>>,
	Expect<Equal<Index['tables']['tasks']['chain'], 'workspace_id' | 'org_id'>>,
	Expect<Equal<keyof UnscopedInsert<Index['tables']['tasks']>, 'title' | 'workspace_id' | 'org_id'>>,
]
