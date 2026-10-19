// The task tracker fixture's types, pinned: tsc fails when one drifts. `RowOf` is the row an action reads; an `over`
// of the org lists tasks two levels down; a column write action updates exactly its columns; a day is text.

import type { Within } from '../capability'
import type { DbIndex, FragmentTable, RowOf, ScopeTarget, Tables, Unavailable, WithinTables } from '../tables'
import type { DB, tables } from './fixtures/tasks'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type Policies = typeof tables extends Tables<DB, infer P> ? P : never
type Index = DbIndex<DB, Policies>
type OnTask<A extends string> = ScopeTarget<Index, 'task', A, 'mutation', 'on'>
type UpdateValues<A extends string> = OnTask<A>['update'] extends (values: infer V, ...version: infer _) => unknown ? V : never

export type TaskTypes = [
	// The row an action reads: `cost` declares its own read action, so only a capability of exactly it reads it.
	Expect<Equal<keyof RowOf<typeof tables, 'tasks'>, Exclude<keyof DB['tasks'], 'cost'>>>,
	Expect<Equal<keyof RowOf<typeof tables, 'tasks', 'tasks.write'>, Exclude<keyof DB['tasks'], 'cost'>>>,
	Expect<Equal<RowOf<typeof tables, 'tasks', 'tasks.assign'>['cost'], number | null>>,
	Expect<Equal<RowOf<typeof tables, 'task_comments', 'tasks.assign'>['pinned'], boolean>>,
	Expect<Equal<RowOf<typeof tables, 'tasks'>['due_on'], string | null>>,
	Expect<Equal<RowOf<typeof tables, 'tasks'>['closed_at'], Date | null>>,
	// A column write action updates its columns and nothing else; the update action does not update them.
	Expect<Equal<UpdateValues<'tasks.assign'>, { assignee?: string | null | undefined }>>,
	Expect<Equal<'assignee' extends keyof UpdateValues<'tasks.write'> ? true : false, false>>,
	Expect<Equal<UpdateValues<'tasks.write'>['closed_at'], Date | string | null | undefined>>,
	Expect<Equal<UpdateValues<'tasks.write'>['due_on'], string | null | undefined>>,
	Expect<
		Equal<
			ScopeTarget<Index, 'task', 'tasks.read', 'mutation', 'on'>['update'],
			Unavailable<"update on tasks needs the action 'tasks.write' or a column's own write action, and this endpoint holds 'tasks.read'">
		>
	>,
	// over: every table whose containment chain holds the dimension.
	Expect<Equal<keyof WithinTables<Index, 'org', 'tasks.read', 'query'>, 'projects' | 'tasks' | 'task_comments'>>,
	Expect<Equal<keyof WithinTables<Index, 'project', 'tasks.read', 'query'>, 'tasks' | 'task_comments'>>,
	Expect<Equal<keyof WithinTables<Index, 'task', 'tasks.read', 'query'>, 'task_comments'>>,
	// A column's own write action scopes an UPDATE of its table on a 'write' site, and reads nothing.
	Expect<Equal<FragmentTable<Index, Within<'project', 'tasks.assign'>, 'write'>, 'tasks' | 'task_comments'>>,
	Expect<
		Equal<
			FragmentTable<Index, Within<'project', 'tasks.assign'>, 'read'>,
			'no table takes a scope fragment of tasks.assign: reach its tables through ctx.db'
		>
	>,
]
