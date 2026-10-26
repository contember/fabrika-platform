// `ctx.sql.scope(…, { use: 'update' })` under a column's own write action: the fragment takes the table's update action
// or any column's own write action. Which columns the statement then sets is the author's and the approver's, as the
// statement is not read for it. No database: the statements are recorded.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { Database } from '../database'
import { bindScopedDatabase, dataAccessOf } from '../framework'
import { defineTables } from '../policy'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'
import { RecordingDialect } from './fixtures/recording-dialect'
import { columns, tables, vocabulary } from './fixtures/tasks'

/** The task tracker with a tasks table that declares no update action: each column it updates names its own writer. */
const columnWritten = defineTables(vocabulary, columns)({
	projects: { scope: { dimension: 'project' }, actions: { read: 'tasks.read', insert: 'tasks.write' }, insert: ['title'] },
	tasks: {
		scope: { dimension: 'task' },
		actions: { read: 'tasks.read', insert: 'tasks.write' },
		insert: ['title', 'status', 'due_on'],
		version: 'version',
		createdBy: 'created_by',
		columns: { assignee: { write: 'tasks.assign' }, status: { write: 'tasks.write' }, closed_at: { write: 'tasks.write' } },
	},
	task_comments: { scope: { child: 'tasks' }, actions: { read: 'tasks.read' } },
})

const Row = z.object({})
const update = { use: 'update' } as const

/** A `'write'` site over `layer`, a data layer `scoped(…)` made. */
function writeSite(layer: unknown) {
	const dialect = new RecordingDialect()
	const authority = new TestAuthority('user:alice')
	bindScopedDatabase(layer, { database: Database.fromDialect(dialect), capabilities: authority })
	const access = dataAccessOf(layer)
	const session = access.direct()
	const sql = access.sql({ mode: 'write', check() {}, session: async () => session, fail: () => session.fail() })
	const inProject = <const A extends string>(action: A) => authority.within('project', action, ['p1'])
	const task = <const A extends string>(action: A) => authority.ref('task', action, 't1', { project: 'p1', org: 'o1' })
	return { sql, inProject, task, sent: () => dialect.log.map((statement) => statement.sql) }
}

describe('a table with only column writes is updated through ctx.sql under the columns’ own action', () => {
	test('a column write action scopes an UPDATE fragment, for a Within and for a Ref', async () => {
		const { sql, inProject, task, sent } = writeSite(scoped(columnWritten))
		await sql(Row)`update tasks set assignee = ${'bob'} where ${sql.scope(inProject('tasks.assign'), 'tasks', update)}`
		await sql(Row)`update tasks set (status, closed_at) = ('done', now()) where ${sql.scope(task('tasks.write'), 'tasks', update)}`
		expect(sent()).toHaveLength(2)
		expect(sent()[0]).toBe('update tasks set assignee = $1 where ((tasks.project_id = any($2)))')
	})

	test('an action that writes no column, and a table without any update, are refused when the fragment is built', () => {
		const { sql, inProject } = writeSite(scoped(columnWritten))
		expect(() => sql.scope(inProject('tasks.read'), 'tasks', update)).toThrow(
			"UPDATE of tasks needs a column's own write action (tasks.assign, tasks.write); the capability holds tasks.read",
		)
		expect(() => sql.scope(inProject('tasks.read'), 'task_comments', update)).toThrow('UPDATE of task_comments: its policy declares no update action')
	})
})

describe('a table with an update action and a column write', () => {
	test('the update action and a column write action both take an UPDATE fragment; a read action does not', () => {
		const { sql, inProject } = writeSite(scoped(tables))
		expect(() => sql.scope(inProject('tasks.write'), 'tasks', update)).not.toThrow()
		expect(() => sql.scope(inProject('tasks.assign'), 'tasks', update)).not.toThrow()
		expect(() => sql.scope(inProject('tasks.read'), 'tasks', update)).toThrow(
			"UPDATE of tasks needs its update action tasks.write or a column's own write action (tasks.assign); the capability holds tasks.read",
		)
	})
})
