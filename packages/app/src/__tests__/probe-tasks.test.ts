// The probe app's task endpoints and overdue job, rewritten on the handles without `ctx.sql`, through `boot` on a REAL
// Postgres: `assign` updates the one column its action writes, `close` and `update` write a subset, `mine` lists the
// caller's tasks across every project of an org, and a due day is `YYYY-MM-DD` both ways. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/app/src/__tests__/probe-tasks.test.ts

import { type ContractApp, type JobClock, serve } from '@fabrika/app/implement'
import { applicationSchema, Database, scoped } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { bootApp, grant, resultOf, send, token } from './fixtures/implement/harness'
import { contract } from './probe-tasks/fabrika.contract'
import { migration } from './probe-tasks/migration'
import { tables } from './probe-tasks/src/db/tables'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`probe-tasks.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const appId = `probe-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
const schema = applicationSchema(appId)
const O1 = { type: 'org', value: 'o1' }
const opened: Database[] = []

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

/** A fresh boot of the fixture, with its own data layer and connection. */
function start(): ContractApp {
	const connection = openPostgres({ url, schema, max: 4 })
	opened.push(connection)
	return bootApp(serve(contract, { database: scoped(tables) }), { database: connection })
}

async function seedTask(project: string, org: string, fields: { status?: string; assignee?: string | null; dueOn?: string | null } = {}) {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(
			`insert into ${schema}.tasks (id, project_id, org_id, title, status, assignee, due_on, created_by, version) values ($1, $2, $3, 'Task', $4, $5, $6, 'u', 1)`,
			[id, project, org, fields.status ?? 'open', fields.assignee ?? null, fields.dueOn ?? null],
		)
	)
	return id
}

async function stored(id: string): Promise<Record<string, unknown> | undefined> {
	const [row] = await admin((sql) =>
		sql.unsafe(`select status, assignee, due_on::text as due_on, overdue, closed_at, version from ${schema}.tasks where id = $1`, [id])
	)
	return row
}

const writer = () => token('user', [grant('tasks.read', O1), grant('tasks.write', O1)])
const assigner = () => token('user', [grant('tasks.read', O1), grant('tasks.assign', O1)])

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`)
		await sql.unsafe(`insert into ${schema}.projects (id, org_id, title) values ('p1', 'o1', 'One'), ('p2', 'o1', 'Two'), ('p3', 'o2', 'Three')`)
	})
})

afterAll(async () => {
	if (!hasPostgres) {
		return
	}
	for (const connection of opened) {
		await connection.close()
	}
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

describe.skipIf(!hasPostgres)('the probe app on the paved road', () => {
	test('assign: the tasks.assign action updates the assignee and nothing else; tasks.write cannot reach it', async () => {
		const app = start()
		const id = await seedTask('p1', 'o1')
		expect(resultOf(await send(app, '/api/tasks.assign', { token: await assigner(), body: { id, expectVersion: 1, assignee: 'user-2' } }))).toEqual({
			id,
			version: 2,
		})
		expect(await stored(id)).toMatchObject({ assignee: 'user-2', status: 'open', version: 2 })
		const stale = await send(app, '/api/tasks.assign', { token: await assigner(), body: { id, expectVersion: 1, assignee: 'user-3' } })
		expect(stale.status).toBe(409)
		const writerOnly = await send(app, '/api/tasks.assign', { token: await writer(), body: { id, expectVersion: 2, assignee: 'user-3' } })
		expect(writerOnly.status).toBe(403)
		expect(await stored(id)).toMatchObject({ assignee: 'user-2', version: 2 })
	})

	test('close: a task in progress closes with a subset of its columns; an open one is 409', async () => {
		const app = start()
		const doing = await seedTask('p1', 'o1', { status: 'doing', dueOn: '2026-10-20' })
		expect(resultOf(await send(app, '/api/tasks.close', { token: await writer(), body: { id: doing, expectVersion: 1 } }))).toEqual({
			id: doing,
			version: 2,
		})
		const closed = await stored(doing)
		expect(closed).toMatchObject({ status: 'done', due_on: '2026-10-20', version: 2 })
		expect(closed?.['closed_at']).toBeInstanceOf(Date)
		const open = await seedTask('p1', 'o1')
		expect((await send(app, '/api/tasks.close', { token: await writer(), body: { id: open, expectVersion: 1 } })).status).toBe(409)
	})

	test('a due day goes in and comes out as YYYY-MM-DD', async () => {
		const app = start()
		const created = resultOf(
			await send(app, '/api/tasks.create', { token: await writer(), body: { projectId: 'p2', title: 'Ship', dueOn: '2026-12-24' } }),
		)
		const id = typeof created === 'object' && created !== null ? String(Reflect.get(created, 'id')) : ''
		expect(resultOf(await send(app, '/api/tasks.get', { token: await writer(), body: { id } }))).toMatchObject({ dueOn: '2026-12-24' })
		expect(resultOf(await send(app, '/api/tasks.update', { token: await writer(), body: { id, expectVersion: 1, dueOn: '2027-01-02' } })))
			.toEqual({ id, version: 2 })
		expect(await stored(id)).toMatchObject({ due_on: '2027-01-02', status: 'open' })
	})

	test("mine: an over org lists the caller's tasks of every project in it, and none of another org", async () => {
		const app = start()
		const own = [await seedTask('p1', 'o1', { assignee: 'user-1' }), await seedTask('p2', 'o1', { assignee: 'user-1', status: 'doing' })]
		await seedTask('p1', 'o1', { assignee: 'user-1', status: 'done' })
		await seedTask('p3', 'o2', { assignee: 'user-1' })
		const listed = resultOf(await send(app, '/api/tasks.mine', { token: await writer(), body: { orgId: 'o1' } }))
		const items: unknown = typeof listed === 'object' && listed !== null ? Reflect.get(listed, 'items') : undefined
		const ids = Array.isArray(items)
			? items.map((item: unknown) => (typeof item === 'object' && item !== null ? Reflect.get(item, 'id') : undefined))
			: []
		expect(ids.sort()).toEqual([...own].sort())
	})

	test('markOverdue marks every task past its due day on the handles, without ctx.sql', async () => {
		const app = start()
		const late = await seedTask('p1', 'o1', { dueOn: '2020-01-01' })
		const lateElsewhere = await seedTask('p3', 'o2', { dueOn: '2020-01-02' })
		const future = await seedTask('p2', 'o1', { dueOn: '2999-01-01' })
		const done = await seedTask('p2', 'o1', { dueOn: '2020-01-01', status: 'done' })
		// No backoff, and an attempt's timeout (a minute or more) never fires.
		const clock: JobClock = {
			wait: (ms, signal) =>
				new Promise<void>((resolve) => (ms < 60_000 ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true }))),
			random: () => 0,
		}
		expect(await app.jobs.run('markOverdue', { clock, reporter: { report: () => Promise.resolve() } })).toEqual({ status: 'succeeded', attempts: 1 })
		expect(await stored(late)).toMatchObject({ overdue: true, version: 2 })
		expect(await stored(lateElsewhere)).toMatchObject({ overdue: true, version: 2 })
		expect(await stored(future)).toMatchObject({ overdue: false, version: 1 })
		expect(await stored(done)).toMatchObject({ overdue: false, version: 1 })
	})
})
