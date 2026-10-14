// The mini-ORM through `boot`'s pipeline on a REAL Postgres: each staged-kit site runs in one invocation transaction,
// committed only after its output passed validation, and every handle is bound to its invocation. Skips cleanly when
// FABRIKA_TEST_POSTGRES_URL is unset:
//
//   docker run --rm -d -p 55433:5432 -e POSTGRES_PASSWORD=postgres postgres:17
//   FABRIKA_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55433/postgres bun test packages/app/src/__tests__/orm-dispatch.test.ts
//
// The file gets its own application schema `app_<id>`. The URL is a credential: it is never logged.

import { BootError, type ContractApp, type JobClock } from '@fabrika/app/implement'
import { applicationSchema, Database } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { siteHandler } from '../implement/invocation'
import { bootApp, grant, resultOf, send, type Sent, token } from './fixtures/implement/harness'
import { ormApp, type OrmHooks, ormHooks } from './orm-fixture/app'
import { migration } from './orm-fixture/migration'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`orm-dispatch.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)
}

const appId = `orm-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
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

/** A fresh boot of the fixture over the shared schema, with its own data layer and connection. */
function start(hooks: OrmHooks = ormHooks()): { app: ContractApp; hooks: OrmHooks } {
	const connection = Database.postgres({ url, schema, max: 4 })
	opened.push(connection)
	return { app: bootApp(ormApp(hooks), { database: connection }), hooks }
}

async function seedDeal(stage: 'lead' | 'won' | 'lost' = 'won', margin: number | null = 12): Promise<string> {
	const id = Bun.randomUUIDv7()
	await admin((sql) =>
		sql.unsafe(
			`insert into ${schema}.deals (id, company_id, org_id, title, stage, margin, created_by, version) values ($1, 'c1', 'o1', 'Deal', $2, $3, 'user-9', 1)`,
			[id, stage, margin],
		)
	)
	return id
}

async function deal(id: string): Promise<Record<string, unknown> | undefined> {
	const [row] = await admin((sql) => sql.unsafe(`select title, stage, version from ${schema}.deals where id = $1`, [id]))
	return row
}

const reader = () => token('user', [grant('crm.read', O1)])
const writer = () => token('user', [grant('crm.read', O1), grant('deals.write', O1)])

/** A 500 with its fixed envelope, and the server log lines it left. */
async function failed(work: () => Promise<Sent>): Promise<string> {
	const log = spyOn(console, 'error').mockImplementation(() => {})
	try {
		const sent = await work()
		expect(sent.status).toBe(500)
		expect(sent.body).toEqual({ error: { type: 'internal', message: 'Internal error' } })
		return log.mock.calls.map((line) => String(line[0])).join('\n')
	} finally {
		log.mockRestore()
	}
}

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin(async (sql) => {
		await sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`)
		await sql.unsafe(`insert into ${schema}.orgs (id, name, created_by, version) values ('o1', 'One', 'u', 1)`)
		await sql.unsafe(`insert into ${schema}.companies (id, org_id, name, created_by, version) values ('c1', 'o1', 'Acme', 'u', 1)`)
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

describe.skipIf(!hasPostgres)('ctx.db through the pipeline', () => {
	test('a write Ref reads its own row; a column of another read action is hidden from a read Ref', async () => {
		const { app } = start()
		const id = await seedDeal('won', 31)
		const read = resultOf(await send(app, '/api/deals.columns', { token: await reader(), body: { id } }))
		expect(read).toEqual({ columns: ['company_id', 'created_by', 'id', 'org_id', 'stage', 'title', 'version'] })
		const written = resultOf(await send(app, '/api/deals.margin', { token: await writer(), body: { id } }))
		expect(written).toEqual({ margin: 31, columns: ['company_id', 'created_by', 'id', 'margin', 'org_id', 'stage', 'title', 'version'] })
	})

	test('two concurrent reopens: one wins, the other waits on the lock, sees the change and is 409', async () => {
		const { app, hooks } = start()
		const id = await seedDeal('won')
		const locked = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		let first = true
		hooks.afterLock = async () => {
			if (first) {
				first = false
				locked.resolve()
				await release.promise
			}
		}
		const body = { id, expectVersion: 1 }
		const winner = send(app, '/api/deals.reopen', { token: await writer(), body })
		await locked.promise
		const loser = send(app, '/api/deals.reopen', { token: await writer(), body })
		await Bun.sleep(50)
		release.resolve()
		const answers = await Promise.all([winner, loser])
		expect(answers.map((answer) => answer.status)).toEqual([200, 409])
		expect(answers[0]?.body).toEqual({ result: { id, version: 2 } })
		expect(answers[1]?.body).toEqual({ error: { type: 'conflict', message: 'only a won or lost deal reopens' } })
		expect(await deal(id)).toEqual({ title: 'Deal', stage: 'proposal', version: 2 })
	})

	test('a thrown handler and a refused output commit nothing; an answer commits', async () => {
		const { app, hooks } = start()
		const id = await seedDeal()
		const rename = async (title: string) => send(app, '/api/deals.rename', { token: await writer(), body: { id, title, expectVersion: 1 } })
		hooks.rename = 'throw'
		await failed(() => rename('thrown'))
		expect(await deal(id)).toEqual({ title: 'Deal', stage: 'won', version: 1 })
		hooks.rename = 'refused output'
		expect(await failed(() => rename('refused'))).toContain('returned a value its output schema refuses')
		expect(await deal(id)).toEqual({ title: 'Deal', stage: 'won', version: 1 })
		hooks.rename = 'answer'
		expect(resultOf(await rename('kept'))).toEqual({ id, version: 2 })
		expect(await deal(id)).toEqual({ title: 'kept', stage: 'won', version: 2 })
	})

	test('an audited export commits its write only with its file: over maxBytes it answers no body and writes nothing', async () => {
		const { app } = start()
		const id = await seedDeal('won')
		const log = await failed(async () =>
			send(app, '/api/deals.exportDeal', { token: await writer(), body: { id, expectVersion: 1, rows: 3, width: 500 } })
		)
		expect(log).toContain('fabrika: api.deals.exportDeal: framework_fault: attachment_size')
		expect(await deal(id)).toEqual({ title: 'Deal', stage: 'won', version: 1 })
		const sent = await send(app, '/api/deals.exportDeal', { token: await writer(), body: { id, expectVersion: 1, rows: 2, width: 3 } })
		expect(sent.status).toBe(200)
		expect(sent.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
		// The harness reads the body as text, which drops the byte order mark.
		expect(sent.body).toBe('line\r\nxxx\r\nxxx\r\n')
		expect(await deal(id)).toEqual({ title: 'exported', stage: 'won', version: 2 })
	})

	test('a query cannot write, not even through unscoped', async () => {
		const { app } = start()
		const id = await seedDeal()
		const log = await failed(async () => send(app, '/api/deals.retitle', { token: await reader(), body: { id, title: 'written', expectVersion: 1 } }))
		expect(log).toContain('query_refused: undeclared_reach')
		expect(await deal(id)).toEqual({ title: 'Deal', stage: 'won', version: 1 })
	})

	test('ctx.sql of a site that does not declare sql refuses by name before anything is sent', async () => {
		const { app, hooks } = start()
		const id = await seedDeal()
		hooks.rename = 'undeclared sql'
		const log = await failed(async () => send(app, '/api/deals.rename', { token: await writer(), body: { id, title: 'written', expectVersion: 1 } }))
		expect(log).toContain('fabrika: api.deals.rename: query_refused: undeclared_reach')
		expect(hooks.kept.refusal).toBe("api.deals.rename does not declare sql, so it has no ctx.sql; add sql: 'read' (or 'write' to write) to it")
		expect(await deal(id)).toEqual({ title: 'Deal', stage: 'won', version: 1 })
	})

	test('boot refuses a query that declares a write, and a declaration of a table outside src/db/tables.ts', () => {
		const declared = (declaration: unknown) => ({
			...ormApp(ormHooks()),
			handlers: () => ({
				api: {
					deals: {
						...Object.fromEntries(
							['columns', 'margin', 'reopen', 'rename', 'keep', 'replay', 'exportDeal'].map((name) => [name, siteHandler(() => ({}), undefined)]),
						),
						retitle: siteHandler(() => ({ ok: true }), declaration),
					},
				},
				github: siteHandler(() => undefined, undefined),
				jobs: { close: siteHandler(() => undefined, undefined) },
			}),
		})
		const problems = (declaration: unknown): readonly string[] => {
			try {
				bootApp(declared(declaration), { database: Database.postgres({ url: 'postgres://u:p@127.0.0.1:1/none', schema }) })
			} catch (error) {
				return error instanceof BootError ? error.problems : []
			}
			return []
		}
		expect(problems({ unscoped: { deals: 'write' } })).toEqual([
			`procedure 'api.deals.retitle': unscoped declares 'deals' as "write"; a query declares only 'read'`,
		])
		expect(problems({ sql: 'write' })).toEqual([`procedure 'api.deals.retitle': sql is "write"; a query declares only sql: 'read'`])
		expect(problems({ unscoped: { fabrika_job_leases: 'read' } })).toEqual([
			`procedure 'api.deals.retitle': unscoped declares 'fabrika_job_leases', which is not a table of src/db/tables.ts`,
		])
	})

	test('a captured handle is refused from another live request and from another boot', async () => {
		const { app, hooks } = start()
		const other = start(hooks)
		const id = await seedDeal()
		const kept = Promise.withResolvers<void>()
		const done = Promise.withResolvers<void>()
		hooks.whileKept = async () => {
			kept.resolve()
			await done.promise
		}
		const keeping = send(app, '/api/deals.keep', { token: await reader(), body: { id } })
		await kept.promise
		expect(await failed(async () => send(app, '/api/deals.replay', { token: await reader(), body: { id } }))).toContain(
			'capability_refused: foreign_work',
		)
		expect(await failed(async () => send(other.app, '/api/deals.replay', { token: await reader(), body: { id } }))).toContain(
			'capability_refused: foreign_work',
		)
		done.resolve()
		expect(resultOf(await keeping)).toEqual({ ok: true })
		expect(await failed(async () => send(app, '/api/deals.replay', { token: await reader(), body: { id } }))).toContain('capability_refused: ended')
	})
})

describe.skipIf(!hasPostgres)('a webhook delivery is one transaction', () => {
	const hook = { 'Content-Type': 'application/json' }

	async function bind(app: ContractApp): Promise<{ id: string; url: string; secret: string }> {
		const manager = await token('user', [grant('members.manage', O1)])
		const result = resultOf(await send(app, '/api/webhooks.github.bind', { token: manager, body: { scope: 'o1', account: 'repository:42' } }))
		const field = (name: string) => String(typeof result === 'object' && result !== null ? Reflect.get(result, name) : '')
		return { id: field('id'), url: field('url'), secret: field('secret') }
	}

	async function deliver(app: ContractApp, binding: { url: string; secret: string }, ref: string): Promise<Sent> {
		const payload = { ref, repository: { id: 42 } }
		const signature = `sha256=${createHmac('sha256', binding.secret).update(JSON.stringify(payload)).digest('hex')}`
		return send(app, binding.url, { body: payload, headers: { ...hook, 'X-Hub-Signature-256': signature, 'X-GitHub-Delivery': 'd-1' } })
	}

	async function companies(prefix: string): Promise<number> {
		const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.companies where name like $1`, [`${prefix}%`]))
		return Number(row?.n)
	}

	test('a delivery that throws commits nothing and runs again; the run that succeeds commits once', async () => {
		const { app, hooks } = start()
		const binding = await bind(app)
		hooks.failNextDelivery = true
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect((await deliver(app, binding, 'refs/heads/once')).status).toBe(500)
		} finally {
			log.mockRestore()
		}
		expect(await companies('refs/heads/once')).toBe(0)
		expect((await deliver(app, binding, 'refs/heads/once')).status).toBe(200)
		expect(hooks.deliveries).toEqual(['refs/heads/once 0', 'refs/heads/once 1'])
		expect(await companies('refs/heads/once')).toBe(1)
		expect((await deliver(app, binding, 'refs/heads/once')).status).toBe(200)
		expect(hooks.deliveries).toHaveLength(2)
	})
})

describe.skipIf(!hasPostgres)('a job writes only in its fenced transaction', () => {
	// No backoff, and an attempt's timeout (a minute or more) never fires.
	const clock: JobClock = {
		wait: (ms, signal) => new Promise<void>((resolve) => (ms < 60_000 ? resolve() : signal.addEventListener('abort', () => resolve(), { once: true }))),
		random: () => 0,
	}
	const reporter = { report: () => Promise.resolve() }

	test('the job closes its lead deals in ctx.transaction; a write outside it fails the attempt and writes nothing', async () => {
		const outside = start()
		outside.hooks.job = 'outside its transaction'
		const lead = await seedDeal('lead')
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect(await outside.app.jobs.run('close', { clock, reporter })).toEqual({ status: 'failed', attempts: 1, code: 'handler_failed' })
		} finally {
			log.mockRestore()
		}
		expect((await deal(lead))?.['stage']).toBe('lead')

		const inside = start()
		expect(await inside.app.jobs.run('close', { clock, reporter })).toEqual({ status: 'succeeded', attempts: 1 })
		expect((await deal(lead))?.['stage']).toBe('lost')
	})

	test('tx.sql of a job that does not declare sql refuses by name, and the attempt writes nothing', async () => {
		const { app, hooks } = start()
		hooks.job = 'undeclared sql'
		const lead = await seedDeal('lead')
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect(await app.jobs.run('close', { clock, reporter })).toEqual({ status: 'failed', attempts: 1, code: 'handler_failed' })
		} finally {
			log.mockRestore()
		}
		expect(hooks.kept.refusal).toBe("job 'close' does not declare sql, so it has no tx.sql; add sql: 'read' (or 'write' to write) to it")
		expect((await deal(lead))?.['stage']).toBe('lead')
	})

	test("a job's captured handles are refused once its attempt ended", async () => {
		const { app, hooks } = start()
		await seedDeal('lead')
		expect(await app.jobs.run('close', { clock, reporter })).toEqual({ status: 'succeeded', attempts: 1 })
		const data = hooks.kept.jobData
		const on = typeof data === 'object' && data !== null ? Reflect.get(data, 'on') : undefined
		expect(typeof on).toBe('function')
		expect(() => (typeof on === 'function' ? Reflect.apply(on, data, [hooks.kept.jobRef]) : undefined)).toThrow('after its invocation ended')
	})
})
