// `ctx.sql.scope` on an UPDATE target under a column's own write action: the action scopes the statement when every
// column the UPDATE assigns declares it, the rule `updatingRef` applies to the handles. No database: the statements
// are recorded.

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
	test('an UPDATE whose every assigned column declares the action is scoped by it, for a Within and for a Ref', async () => {
		const { sql, inProject, task, sent } = writeSite(scoped(columnWritten))
		await sql(Row)`update tasks set assignee = ${'bob'} where ${sql.scope(inProject('tasks.assign'), 'tasks')}`
		await sql(Row)`update tasks t set status = 'done', closed_at = now() where ${sql.scope(inProject('tasks.write'), 'tasks', 't')}`
		await sql(Row)`update tasks set (status, closed_at) = ('done', now()) where ${sql.scope(task('tasks.write'), 'tasks')}`
		await sql(Row)`insert into tasks (id, project_id, org_id, title, created_by, version) values ('t1', 'p1', 'o1', 'x', 'u', 1)
			on conflict (id) do update set assignee = excluded.assignee where ${sql.scope(task('tasks.assign'), 'tasks')}`
		expect(sent()).toHaveLength(4)
		expect(sent()[0]).toBe('update tasks set assignee = $1 where ((tasks.project_id = any($2)))')
	})

	test('an action that does not write every assigned column is refused before anything is sent', async () => {
		const { sql, inProject, task, sent } = writeSite(scoped(columnWritten))
		await expect(
			sql(Row)`update tasks set assignee = ${'bob'}, status = 'done' where ${sql.scope(inProject('tasks.assign'), 'tasks')}`,
		).rejects.toThrow('UPDATE of tasks assigns status, which tasks.assign does not write')
		await expect(sql(Row)`update tasks set title = ${'x'} where ${sql.scope(task('tasks.write'), 'tasks')}`).rejects.toThrow(
			'UPDATE of tasks assigns title, which tasks.write does not write',
		)
		await expect(sql(Row)`update tasks set assignee = ${'bob'} where ${sql.scope(inProject('tasks.read'), 'tasks')}`).rejects.toThrow(
			"UPDATE of tasks needs a column's own write action (tasks.assign, tasks.write); the capability holds tasks.read",
		)
		expect(sent()).toEqual([])
	})

	test('a table without an update action and without a column write still refuses every UPDATE fragment', async () => {
		const { sql, inProject } = writeSite(scoped(columnWritten))
		await expect(sql(Row)`update task_comments set body = ${'x'} where ${sql.scope(inProject('tasks.read'), 'task_comments')}`).rejects.toThrow(
			'UPDATE of task_comments: its policy declares no update action',
		)
	})
})

describe('a table with an update action and a column write', () => {
	test('the update action scopes any UPDATE, and a column write action only its own columns', async () => {
		const { sql, inProject, sent } = writeSite(scoped(tables))
		await sql(Row)`update tasks set title = ${'x'} where ${sql.scope(inProject('tasks.write'), 'tasks')}`
		await sql(Row)`update tasks set assignee = ${'bob'} where ${sql.scope(inProject('tasks.assign'), 'tasks')}`
		expect(sent()).toHaveLength(2)
		await expect(sql(Row)`update tasks set title = ${'x'} where ${sql.scope(inProject('tasks.assign'), 'tasks')}`).rejects.toThrow(
			'UPDATE of tasks assigns title, which tasks.assign does not write',
		)
		await expect(sql(Row)`update tasks set title = ${'x'} where ${sql.scope(inProject('tasks.read'), 'tasks')}`).rejects.toThrow(
			"UPDATE of tasks needs its update action tasks.write or a column's own write action (tasks.assign); the capability holds tasks.read",
		)
	})

	test("ctx.sql.scope itself takes a column's write action on a 'write' site, before any statement names the columns", () => {
		const { sql, inProject } = writeSite(scoped(tables))
		expect(() => sql.scope(inProject('tasks.assign'), 'tasks')).not.toThrow()
	})
})
