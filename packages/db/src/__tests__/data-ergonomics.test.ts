// What two fresh-agent probes needed of the paved road, on a REAL Postgres: a column only its own action writes, an
// update of any non-empty subset of the columns, `over` lists two levels down through the stamped chain, and a `date`
// column as `YYYY-MM-DD` end to end. Skips cleanly (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/db/src/__tests__/data-ergonomics.test.ts

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { Database, type InvocationTransaction } from '../database'
import { CapabilityError, ConflictError, QueryRefusedError } from '../errors'
import { bindScopedDatabase, type DataAccess, dataAccessOf, type DataSite } from '../framework'
import type { DataKind } from '../orm-types'
import { scoped } from '../store'
import { TestAuthority } from './fixtures/authority'
import { migration, tables } from './fixtures/tasks'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR]
const hasPostgres = url !== undefined && url !== ''

if (!hasPostgres) {
	console.warn(`data-ergonomics.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const schema = `ergo_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const alice = new TestAuthority('user:alice')
let database: Database
let data: DataAccess

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}`)
		await sql.unsafe(`set search_path to ${schema}; ${migration}`)
		await sql.unsafe(`insert into ${schema}.projects (id, org_id, title) values ('p1', 'o1', 'One'), ('p2', 'o1', 'Two'), ('p3', 'o2', 'Three')`)
	})
	database = Database.postgres({ url: url ?? '', schema, max: 4 })
	const layer = scoped(tables)
	bindScopedDatabase(layer, { database, capabilities: alice })
	data = dataAccessOf(layer)
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	await database.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

/** One invocation and the handles the framework would build for its site. */
function invocation(kind: DataKind) {
	const transaction: InvocationTransaction = data.invocation(kind === 'query')
	const site: DataSite = {
		kind,
		unscoped: {},
		principal: 'user:alice',
		check() {
			if (transaction.ended) {
				throw new QueryRefusedError('ended', 'this invocation has ended')
			}
		},
		session: () => transaction.session(),
	}
	return { transaction, handles: data.handles(site), site }
}

/** Calls `path` (`tasks.list`, `update`) on an untyped handle, as a handler whose types were defeated would. */
async function call(handle: unknown, path: string, ...args: unknown[]): Promise<unknown> {
	const parts = path.split('.')
	const name = parts.pop() ?? ''
	const target = parts.reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? Reflect.get(node, part) : undefined), handle)
	const method: unknown = typeof target === 'object' && target !== null ? Reflect.get(target, name) : undefined
	if (typeof method !== 'function') {
		throw new TypeError(`${path} is not a method of the handle`)
	}
	return Reflect.apply(method, target, args)
}

/** One committed mutation's call, answered. */
async function mutate(work: (handles: ReturnType<typeof invocation>['handles']) => Promise<unknown>): Promise<unknown> {
	const { transaction, handles } = invocation('mutation')
	try {
		const answer = await work(handles)
		await transaction.commit()
		return answer
	} catch (error) {
		await transaction.rollback()
		throw error
	}
}

const task = <const A extends string>(action: A, id: string, project = 'p1', org = 'o1') => alice.ref('task', action, id, { project, org })

interface Seed {
	readonly title?: string
	readonly project?: string
	readonly org?: string
	readonly dueOn?: string | null
	readonly cost?: number | null
}

async function seedTask({ title = 'task', project = 'p1', org = 'o1', dueOn = null, cost = 5 }: Seed = {}): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(
			`insert into ${schema}.tasks (id, project_id, org_id, title, due_on, cost, created_by, version) values ($1, $2, $3, $4, $5, $6, 'u', 1)`,
			[id, project, org, title, dueOn, cost],
		)
	)
	return id
}

async function row(table: string, id: string): Promise<Record<string, unknown> | undefined> {
	const [found] = await admin((sql) => sql.unsafe(`select * from ${schema}.${table} where id = $1`, [id]))
	return found
}

function itemsOf(page: unknown): Record<string, unknown>[] {
	const items: unknown = typeof page === 'object' && page !== null ? Reflect.get(page, 'items') : undefined
	return Array.isArray(items) ? items : []
}

function nextOf(page: unknown): unknown {
	return typeof page === 'object' && page !== null ? Reflect.get(page, 'next') : undefined
}

function keysOf(value: unknown): string[] {
	return typeof value === 'object' && value !== null ? Object.keys(value).sort() : []
}

describe.skipIf(!hasPostgres)('a column write action', () => {
	test('a capability of it reads its own row and updates exactly its columns, with the version bumped', async () => {
		const id = await seedTask({ title: 'assign me' })
		const { transaction, handles } = invocation('mutation')
		const target = handles.target(task('tasks.assign', id), 'on')
		expect(keysOf(await call(target, 'get'))).toContain('cost')
		expect(keysOf(await call(handles.target(task('tasks.write', id), 'on'), 'get'))).not.toContain('cost')
		expect(await call(target, 'update', { assignee: 'user:bob' }, { expectVersion: 1 })).toEqual({ id, version: 2 })
		await transaction.commit()
		expect(await row('tasks', id)).toMatchObject({ assignee: 'user:bob', title: 'assign me', version: 2 })
	})

	test('it writes no other column, and the update action does not write its column', async () => {
		const id = await seedTask()
		await expect(mutate((handles) => call(handles.target(task('tasks.assign', id), 'on'), 'update', { title: 'x' }, { expectVersion: 1 })))
			.rejects.toThrow('title is not an update column of tasks (update columns: assignee)')
		await expect(mutate((handles) => call(handles.target(task('tasks.write', id), 'on'), 'update', { assignee: 'x' }, { expectVersion: 1 })))
			.rejects.toThrow('assignee is not an update column of tasks (update columns: title, status, due_on, closed_at, overdue)')
		await expect(mutate((handles) => call(handles.target(task('tasks.read', id), 'on'), 'update', { title: 'x' }, { expectVersion: 1 })))
			.rejects.toThrow(new CapabilityError('update on tasks requires tasks.write or tasks.assign; the capability holds tasks.read'))
		expect(await row('tasks', id)).toMatchObject({ assignee: null, title: 'task', version: 1 })
	})

	test('a stale expectVersion is 409, as for the update action', async () => {
		const id = await seedTask()
		await expect(mutate((handles) => call(handles.target(task('tasks.assign', id), 'on'), 'update', { assignee: 'x' }, { expectVersion: 4 })))
			.rejects.toBeInstanceOf(ConflictError)
	})

	test("a child table's column write action: the target's Ref of it updates that column of a child row", async () => {
		const id = await seedTask()
		const comment = await mutate((handles) => call(handles.target(task('tasks.write', id), 'on'), 'task_comments.insert', { body: 'hi' }))
		const commentId = typeof comment === 'object' && comment !== null ? String(Reflect.get(comment, 'id')) : ''
		await mutate((handles) => call(handles.target(task('tasks.assign', id), 'on'), 'task_comments.update', commentId, { pinned: true }))
		await expect(mutate((handles) => call(handles.target(task('tasks.assign', id), 'on'), 'task_comments.update', commentId, { body: 'x' })))
			.rejects.toThrow('body is not an update column of task_comments (update columns: pinned)')
		expect(await row('task_comments', commentId)).toMatchObject({ body: 'hi', pinned: true })
	})
})

describe.skipIf(!hasPostgres)('an update takes any subset of the columns its action writes', () => {
	test('one column changes, the others keep their values', async () => {
		const id = await seedTask({ title: 'keep', dueOn: '2026-10-20' })
		expect(await mutate((handles) => call(handles.target(task('tasks.write', id), 'on'), 'update', { status: 'doing' }, { expectVersion: 1 })))
			.toEqual({ id, version: 2 })
		const stored = await row('tasks', id)
		expect(stored).toMatchObject({ status: 'doing', title: 'keep', version: 2 })
	})

	test('an update that sets no column answers the current acknowledgement and writes nothing, not even the version', async () => {
		const id = await seedTask()
		for (const values of [{}, { title: undefined }]) {
			expect(await mutate((handles) => call(handles.target(task('tasks.write', id), 'on'), 'update', values, { expectVersion: 1 })))
				.toEqual({ id, version: 1 })
		}
		expect((await row('tasks', id))?.['version']).toBe(1)
		await expect(mutate((handles) => call(handles.target(task('tasks.write', id), 'on'), 'update', {}, { expectVersion: 2 })))
			.rejects.toThrow('tasks was changed by someone else')
		await expect(mutate((handles) => call(handles.target(task('tasks.write', Bun.randomUUIDv7()), 'on'), 'update', {}, { expectVersion: 1 })))
			.rejects.toThrow('tasks not found')
	})
})

describe.skipIf(!hasPostgres)('over lists every table whose containment chain holds its dimension', () => {
	test('a Within of org lists tasks of every project in it through their stamped org_id, page by page', async () => {
		const marker = `org-${Bun.randomUUIDv7()}`
		const own = [await seedTask({ title: marker, project: 'p1' }), await seedTask({ title: marker, project: 'p2' })]
		await seedTask({ title: marker, project: 'p3', org: 'o2' })
		const { transaction, handles } = invocation('query')
		const within = handles.within(alice.within('org', 'tasks.read', ['o1']))
		expect(keysOf(within)).toEqual(['projects', 'task_comments', 'tasks'])
		const seen: string[] = []
		let after: unknown
		do {
			const page = await call(within, 'tasks.list', { where: [['title', '=', marker]], limit: 1, ...(after === undefined ? {} : { after }) })
			for (const item of itemsOf(page)) {
				seen.push(String(item['id']))
				expect(keysOf(item)).not.toContain('cost')
			}
			after = nextOf(page) ?? undefined
		} while (after !== undefined)
		expect(seen.sort()).toEqual([...own].sort())
		expect(await call(within, 'tasks.count', { where: [['title', '=', marker]] })).toBe(2)
		await expect(call(within, 'tasks.list', { orderBy: [['cost', 'asc']] })).rejects.toThrow('cost is not a column of tasks')
		await transaction.commit()
	})

	test("a task cannot carry another org than its project's, so no Within of an org lists another org's task", async () => {
		// The composite foreign key the policy parse requires ties the inherited org_id to the project's own.
		await expect(seedTask({ title: 'misplaced', project: 'p3', org: 'o1' })).rejects.toThrow()
		const { transaction, handles } = invocation('query')
		const page = await call(handles.within(alice.within('org', 'tasks.read', ['o1'])), 'tasks.list', { where: [['project_id', '=', 'p3']] })
		expect(itemsOf(page)).toEqual([])
		await transaction.commit()
	})

	test('a container grant above the dimension still reaches through its chain column', async () => {
		const marker = `grant-${Bun.randomUUIDv7()}`
		const id = await seedTask({ title: marker, project: 'p2' })
		const { transaction, handles } = invocation('query')
		const viaOrg = handles.within(alice.within('project', 'tasks.read', [], [{ dimension: 'org', values: ['o1'] }]))
		expect(itemsOf(await call(viaOrg, 'tasks.list', { where: [['title', '=', marker]] })).map((item) => item['id'])).toEqual([id])
		await transaction.commit()
	})

	test('a child table two levels down is listed too, and a Within of task reaches only what its chain holds', async () => {
		const id = await seedTask()
		await mutate((handles) => call(handles.target(task('tasks.write', id), 'on'), 'task_comments.insert', { body: `under ${id}` }))
		const { transaction, handles } = invocation('query')
		const byOrg = handles.within(alice.within('org', 'tasks.read', ['o1']))
		expect(itemsOf(await call(byOrg, 'task_comments.list', { where: [['task_id', '=', id]] })).map((item) => item['body'])).toEqual([
			`under ${id}`,
		])
		expect(keysOf(handles.within(alice.within('task', 'tasks.read', [id])))).toEqual(['task_comments'])
		await expect(call(byOrg, 'tasks.list')).resolves.toBeDefined()
		await expect(call(handles.within(alice.within('org', 'tasks.write', ['o1'])), 'tasks.list')).rejects.toThrow(
			'read on tasks requires tasks.read; the capability holds tasks.write',
		)
		await transaction.commit()
	})
})

describe.skipIf(!hasPostgres)('a date column is a YYYY-MM-DD string end to end; a timestamp takes ISO text', () => {
	test('reads, filters, aggregates and writes answer and take the day as text', async () => {
		const marker = `day-${Bun.randomUUIDv7()}`
		const id = await seedTask({ title: marker, dueOn: '2026-10-20' })
		const { transaction, handles } = invocation('query')
		const target = handles.target(task('tasks.read', id), 'on')
		expect(await call(target, 'get')).toMatchObject({ due_on: '2026-10-20' })
		const within = handles.within(alice.within('org', 'tasks.read', ['o1']))
		const page = await call(within, 'tasks.list', { where: [['title', '=', marker], ['due_on', '<', '2026-10-21']] })
		expect(itemsOf(page).map((item) => item['due_on'])).toEqual(['2026-10-20'])
		expect(await call(within, 'tasks.aggregate', { groupBy: ['due_on'], max: ['due_on'] })).toContainEqual({
			due_on: '2026-10-20',
			max_due_on: '2026-10-20',
		})
		await transaction.commit()

		const created = await mutate((handles) =>
			call(handles.target(alice.ref('project', 'tasks.write', 'p1', { org: 'o1' }), 'in'), 'tasks.insert', {
				title: marker,
				due_on: '2026-11-01',
			})
		)
		const createdId = typeof created === 'object' && created !== null ? String(Reflect.get(created, 'id')) : ''
		const reread = invocation('query')
		expect(await call(reread.handles.target(task('tasks.read', createdId), 'on'), 'get')).toMatchObject({ due_on: '2026-11-01' })
		await reread.transaction.commit()
	})

	test('a timestamp write takes ISO text as well as a Date', async () => {
		const id = await seedTask()
		await mutate((handles) =>
			call(handles.target(task('tasks.write', id), 'on'), 'update', { closed_at: '2026-10-12T08:30:00.000Z' }, { expectVersion: 1 })
		)
		expect((await row('tasks', id))?.['closed_at']).toEqual(new Date('2026-10-12T08:30:00.000Z'))
		await mutate((handles) =>
			call(handles.target(task('tasks.write', id), 'on'), 'update', { closed_at: new Date('2026-10-13T09:00:00.000Z') }, { expectVersion: 2 })
		)
		const { transaction, handles } = invocation('query')
		expect(await call(handles.target(task('tasks.read', id), 'on'), 'get')).toMatchObject({ closed_at: new Date('2026-10-13T09:00:00.000Z') })
		await transaction.commit()
	})

	test('a relative, locale, offset-less or impossible text is refused before it is sent, and the row keeps its version', async () => {
		const id = await seedTask()
		const update = (values: Readonly<Record<string, unknown>>) =>
			mutate((handles) => call(handles.target(task('tasks.write', id), 'on'), 'update', values, { expectVersion: 1 }))
		const instant = 'tasks.closed_at takes a Date or ISO 8601 text with Z or an offset'
		for (const text of ['now', '10/12/2026', '2026-02-30T00:00:00Z', '2026-10-12T08:30:00', '2026-10-12 08:30:00Z', '2026-10-12T24:00:00Z']) {
			await expect(update({ closed_at: text })).rejects.toThrow(instant)
		}
		for (const text of ['today', '2026-02-30', '20/10/2026', '2026-10-20T00:00:00Z']) {
			await expect(update({ due_on: text })).rejects.toThrow('tasks.due_on takes a day as YYYY-MM-DD text')
		}
		await expect(
			mutate((handles) =>
				call(handles.target(alice.ref('project', 'tasks.write', 'p1', { org: 'o1' }), 'in'), 'tasks.insert', { title: 'x', due_on: 'tomorrow' })
			),
		).rejects.toThrow('tasks.due_on takes a day as YYYY-MM-DD text')
		expect(await row('tasks', id)).toMatchObject({ closed_at: null, due_on: null, version: 1 })
		expect(await update({ closed_at: '2026-10-12T10:30:00.123456+02:00' })).toEqual({ id, version: 2 })
		expect((await row('tasks', id))?.['closed_at']).toEqual(new Date('2026-10-12T08:30:00.123Z'))
	})

	test('ctx.sql answers a day for a z.iso.date() field and an instant for a datetime one', async () => {
		const id = await seedTask({ dueOn: '2026-10-20' })
		await admin((sql) => sql.unsafe(`update ${schema}.tasks set closed_at = '2026-10-21T10:00:00Z' where id = $1`, [id]))
		const { transaction, site } = invocation('query')
		const sql = data.sql({ mode: 'read', check: () => site.check(), session: () => transaction.session(), fail: () => transaction.fail() })
		const Row = z.strictObject({ dueOn: z.iso.date(), closedAt: z.iso.datetime(), later: z.iso.date().nullable() })
		expect(await sql(Row)`select due_on, closed_at, null::date as later from tasks where id = ${id}`).toEqual([
			{ dueOn: '2026-10-20', closedAt: '2026-10-21T10:00:00.000Z', later: null },
		])
		await transaction.commit()
	})

	test('east of UTC, a day past 9999 is refused in a row, an aggregate and ctx.sql, never answered as a neighbouring day', async () => {
		// Bun decodes 10000-01-01 as 9999-12-31T23:00Z in Prague: a valid-looking day one off.
		const originalTimeZone = process.env['TZ']
		process.env['TZ'] = 'Europe/Prague'
		try {
			expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(-60)
			const marker = `far-${Bun.randomUUIDv7()}`
			const id = await seedTask({ title: marker, project: 'p2' })
			await admin((sql) => sql.unsafe(`update ${schema}.tasks set due_on = '10000-01-01' where id = $1`, [id]))
			const { transaction, handles, site } = invocation('query')
			const where = 'tasks.due_on holds a date outside 0001-01-01 to 9999-12-31'
			await expect(call(handles.target(task('tasks.read', id, 'p2'), 'on'), 'get')).rejects.toThrow(where)
			const within = handles.within(alice.within('project', 'tasks.read', ['p2']))
			await expect(call(within, 'tasks.list', { where: [['title', '=', marker]] })).rejects.toThrow(where)
			await expect(call(within, 'tasks.aggregate', { max: ['due_on'] })).rejects.toThrow('tasks.max_due_on holds a date outside')
			const sql = data.sql({ mode: 'read', check: () => site.check(), session: () => transaction.session(), fail: () => transaction.fail() })
			await expect(sql(z.strictObject({ dueOn: z.iso.date() }))`select due_on from tasks where id = ${id}`).rejects.toThrow(
				"ctx.sql: the column 'due_on' holds a date outside",
			)
			await transaction.rollback()
			await admin((sql) => sql.unsafe(`delete from ${schema}.tasks where id = $1`, [id]))
		} finally {
			if (originalTimeZone === undefined) {
				delete process.env['TZ']
			} else {
				process.env['TZ'] = originalTimeZone
			}
		}
	})

	test('a day the driver cannot decode is refused rather than answered wrong', async () => {
		const id = await seedTask()
		await admin((sql) => sql.unsafe(`update ${schema}.tasks set due_on = 'infinity' where id = $1`, [id]))
		const { transaction, handles } = invocation('query')
		await expect(call(handles.target(task('tasks.read', id), 'on'), 'get')).rejects.toThrow(
			'tasks.due_on holds a date outside 0001-01-01 to 9999-12-31',
		)
		await transaction.rollback()
	})
})
