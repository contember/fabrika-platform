// A Cloudflare application on Postgres (ADR-0065, Hyperdrive): the Worker boots the application once per isolate and
// serves each request on a postgres.js client of its own, which ends only once the request's tracked work settled; a
// request's kick writes its wake and runs nothing in the Worker, which tells the job object afterwards; the job object
// answers only its Worker, lowers its alarm and never raises it, runs a due job under its lease from the alarm, re-arms
// within its refresh, and survives an internal error. The Worker and the object are constructed directly, over a REAL
// Postgres reached as the runtime role through postgres.js, and Lopata's R2. Skips cleanly when FABRIKA_TEST_POSTGRES_URL
// is unset.

import { OPS_PREFIX, PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { applicationRuntimeUrl, definePostgresApplicationMigrations, dropApplicationDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { createTestEnv, type TestEnv } from 'lopata/testing'
import { join } from 'node:path'
import { applicationMigrations, CLOUDFLARE_APPLICATION_BINDING, CLOUDFLARE_DATABASE_BINDING, CLOUDFLARE_FILES_BINDING } from '../build'
import type { CloudflareExecutionContext } from '../cloudflare'
import {
	createPostgresContractWorker,
	FabrikaJobObject,
	type JobObjectState,
	POSTGRES_ALARM_REFRESH_MS,
	type PostgresEventClient,
	type PostgresWorkerOptions,
	WAKE_DELAY_HEADER,
	WAKE_PATH,
} from '../cloudflare-postgres'
import { TICK_HEADER } from '../cloudflare/application'
import { ALARM_RETRY_MS } from '../cloudflare/application'
import { connectHyperdrive } from '../cloudflare/postgres-runtime'
import { type CfpgApp, cfpgApp } from './cloudflare-postgres-fixture/src/app'
import type { CfpgWorld } from './cloudflare-postgres-fixture/src/world'
import {
	endpointHeaderFor,
	frameworkEnvFor,
	grant,
	ISSUER,
	keepingProcessEnvironment,
	keySource,
	ORIGIN,
	PROXY_SECRET,
	token,
	workloadTokensFor,
} from './fixtures/implement/harness'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`cloudflare-postgres-adapter.test.ts skipped: set ${URL_VAR} to run it (the Worker serves the application from Postgres)`)
}

const FIXTURE_ROOT = join(import.meta.dir, 'cloudflare-postgres-fixture')
/** The fixture vocabulary's application id. */
const APP = 'cfpg'
const APP_ENV = `${APP}@prod`
const SCHEMA = `app_${APP}`
const RUNTIME_ROLE = `run_${APP}`
const DSN = 'https://0123456789abcdef0123456789abcdef@operations.test/42'
const WORKSPACE = { type: 'workspace', value: 'w1' }

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

/** What `fabrika db migrate` does on a deploy, and the runtime role's default search_path its provisioning sets (WU1). */
async function provision(): Promise<void> {
	await dropApplicationDatabase(url, APP)
	const framework = { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: FRAMEWORK_MIGRATIONS }
	await definePostgresApplicationMigrations({ appId: APP, directory: '/unused', framework }).migrate(url, [
		...(await applicationMigrations(FIXTURE_ROOT)),
	])
	await admin((sql) => sql.unsafe(`alter role ${RUNTIME_ROLE} set search_path to ${SCHEMA}`))
}

let runtimeUrl = ''
let r2: TestEnv | null = null

beforeAll(async () => {
	if (!hasPostgres) return
	await provision()
	runtimeUrl = applicationRuntimeUrl(url, APP)
	r2 = await createTestEnv({ bindings: { FILES: 'r2' } })
})

afterAll(async () => {
	r2?.dispose()
	if (!hasPostgres) return
	await dropApplicationDatabase(url, APP)
})

beforeEach(async () => {
	if (!hasPostgres) return
	await admin((sql) =>
		sql.unsafe(
			`truncate ${SCHEMA}.notes; delete from ${SCHEMA}.fabrika_job_leases; delete from ${SCHEMA}.fabrika_job_kicks; delete from ${SCHEMA}.fabrika_wakes`,
		)
	)
})

/** Every client the Worker and the object opened, in order: whether it ended, and while what was still tracked. */
interface OpenedClient {
	readonly connectionString: string
	ended: boolean
}

/** A gate a test holds work at. */
function gate() {
	const opened = Promise.withResolvers<void>()
	const reached = Promise.withResolvers<void>()
	return {
		reached: reached.promise,
		open: () => opened.resolve(),
		wait: async () => {
			reached.resolve()
			await opened.promise
		},
	}
}

/** The Durable Object state: its alarm in memory, its `waitUntil` collected. */
class ObjectState implements JobObjectState {
	alarm: number | null = null
	readonly pending: Promise<unknown>[] = []
	readonly storage = {
		setAlarm: async (at: number) => {
			this.alarm = at
		},
		getAlarm: async () => this.alarm,
		deleteAlarm: async () => {
			this.alarm = null
		},
	}

	waitUntil(promise: Promise<unknown>): void {
		this.pending.push(promise)
	}

	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
		return callback()
	}

	async settled(): Promise<void> {
		while (this.pending.length > 0) {
			await Promise.all(this.pending.splice(0))
		}
	}
}

interface Deployed {
	readonly world: CfpgWorld
	readonly served: CfpgApp
	readonly worker: ReturnType<typeof createPostgresContractWorker>
	readonly env: Record<string, unknown>
	readonly state: ObjectState
	readonly object: FabrikaJobObject
	readonly clients: OpenedClient[]
	/** What the Worker sent its object, in order. */
	readonly sent: Request[]
	/** What the Worker handed to `waitUntil`. */
	readonly pending: Promise<unknown>[]
	readonly exec: CloudflareExecutionContext
	loads: number
	/** Holds the Worker's next request to its object until the test opens it. */
	holdObject: ReturnType<typeof gate> | null
	/** Every client opened from here on refuses its connection. */
	broken: boolean
	settled(): Promise<void>
}

/** The fixture as the provider deploys it: the Worker, its job object behind the namespace, the database, the bucket. */
function deploy(options: Omit<PostgresWorkerOptions, 'connect'> & { readonly vars?: Readonly<Record<string, unknown>> } = {}): Deployed {
	const world: CfpgWorld = { runs: [] }
	const served = cfpgApp(world)
	const clients: OpenedClient[] = []
	const sent: Request[] = []
	const pending: Promise<unknown>[] = []
	const tokens = workloadTokensFor(served.implementation, undefined, ISSUER, APP_ENV)
	const connect = (connectionString: string): PostgresEventClient => {
		const opened: OpenedClient = { connectionString, ended: false }
		clients.push(opened)
		if (deployed.broken) {
			return { reserve: () => Promise.reject(new Error('connection refused')), end: async () => void (opened.ended = true) }
		}
		const sql = connectHyperdrive(connectionString)
		return {
			reserve: () => sql.reserve(),
			end: async (endOptions) => {
				opened.ended = true
				await sql.end(endOptions)
			},
		}
	}
	const worker = createPostgresContractWorker(() => {
		deployed.loads++
		return Promise.resolve({ default: served.implementation })
	}, { ...options, connect })
	const state = new ObjectState()
	const namespace = {
		idFromName: (name: string) => name,
		get: (id: string) => ({
			fetch: async (request: Request) => {
				expect(id).toBe('application')
				sent.push(request.clone())
				const hold = deployed.holdObject
				deployed.holdObject = null
				await hold?.wait()
				return await deployed.object.fetch(request)
			},
		}),
	}
	const env: Record<string, unknown> = {
		...frameworkEnvFor(served.implementation),
		FABRIKA_IAM_APP_ID: APP_ENV,
		...served.variables,
		FABRIKA_PROXY_SECRET: PROXY_SECRET,
		[CLOUDFLARE_DATABASE_BINDING]: { connectionString: runtimeUrl },
		[CLOUDFLARE_FILES_BINDING]: r2?.env['FILES'],
		[CLOUDFLARE_APPLICATION_BINDING]: namespace,
		IAM: { getJwks: () => keySource.getJwks(), mintFromKey: (input: { app: string; key: string }) => tokens.exchange(input) },
		...options.vars,
	}
	const exec: CloudflareExecutionContext = { waitUntil: (promise) => void pending.push(promise), passThroughOnException: () => {} }
	const deployed: Deployed = {
		world,
		served,
		worker,
		env,
		state,
		object: new FabrikaJobObject(state, env),
		clients,
		sent,
		pending,
		exec,
		loads: 0,
		holdObject: null,
		broken: false,
		async settled() {
			while (pending.length > 0 || state.pending.length > 0) {
				await Promise.all(pending.splice(0))
				await state.settled()
			}
		},
	}
	return deployed
}

async function call(target: Deployed, procedure: string, input: unknown, headers: Record<string, string> = {}): Promise<Response> {
	const path = `/api/notes.${procedure}`
	return await target.worker.fetch(
		new Request(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				'X-Fabrika-Token': await token('user', [grant('notes.read', WORKSPACE), grant('notes.write', WORKSPACE)], APP_ENV),
				'X-Fabrika-Endpoint': endpointHeaderFor(target.served.implementation, 'POST', path) ?? '',
				'Content-Type': 'application/json',
				'Sec-Fetch-Site': 'same-origin',
				...headers,
			},
			body: JSON.stringify(input),
		}),
		target.env,
		target.exec,
	)
}

async function rows<T>(query: string): Promise<T[]> {
	return await admin(async (sql) => {
		const result: T[] = await sql.unsafe(query)
		return [...result]
	})
}

/** A request to the object as its Worker sends one, with the proxy secret. */
function fromWorker(path: string, headers: Record<string, string> = {}, method = 'POST'): Request {
	return new Request(`https://application.invalid${path}`, { method, headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET, ...headers } })
}

/** Runs `work` with the process environment restored afterwards: a boot scrubs every FABRIKA_* variable from it. */
const inProcess = (work: () => Promise<void>) => () => keepingProcessEnvironment(work)

describe.skipIf(!hasPostgres)('the Worker', () => {
	test(
		'boots once per isolate, shared with the job object, and serves through ctx.db on the runtime role',
		inProcess(async () => {
			const target = deploy()
			expect((await call(target, 'create', { workspaceId: 'w1', title: 'first' })).status).toBe(200)
			const titles = await call(target, 'titles', { workspaceId: 'w1' })
			expect(await titles.json()).toEqual({ result: { titles: ['first'] } })
			await target.object.alarm()
			await target.settled()
			expect(target.loads).toBe(1)
			expect(target.clients.every((client) => client.connectionString === runtimeUrl)).toBe(true)
		}),
	)

	test(
		'opens a client per request and ends it only after the work the request handed to waitUntil',
		inProcess(async () => {
			const report = gate()
			const target = deploy({
				vars: { FABRIKA_OPERATIONS_DSN: DSN },
				operationsFetch: async () => {
					await report.wait()
					return new Response(null, { status: 202 })
				},
			})
			const log = spyOn(console, 'error').mockImplementation(() => {})
			try {
				expect((await call(target, 'titles', { workspaceId: 'w1' })).status).toBe(200)
				await target.settled()
				expect(target.clients).toHaveLength(1)
				expect(target.clients[0]?.ended).toBe(true)

				// The failure's report is the request's tracked work: the client outlives the response until it is sent.
				expect((await call(target, 'createThenFail', { workspaceId: 'w1', title: 'gone' })).status).toBe(500)
				await report.reached
				expect(target.clients).toHaveLength(2)
				expect(target.clients[1]?.ended).toBe(false)
				report.open()
				await target.settled()
				expect(target.clients[1]?.ended).toBe(true)
			} finally {
				log.mockRestore()
			}
			expect(await rows(`select title from ${SCHEMA}.notes`)).toEqual([])
		}),
	)

	test(
		'sets the proxy secret itself, serves a request that carries the tick header as a request, and refuses ops',
		inProcess(async () => {
			const target = deploy()
			// The caller sent neither the secret nor a valid tick; `boot` requires the secret and gets it from the Worker.
			const response = await call(target, 'titles', { workspaceId: 'w1' }, { [TICK_HEADER]: '1', [PROXY_SECRET_HEADER]: 'forged' })
			expect(response.status).toBe(200)
			await target.settled()
			expect(target.sent).toEqual([])

			const ops = deploy()
			const refused = await ops.worker.fetch(new Request(`${ORIGIN}${OPS_PREFIX}state`, { method: 'POST', body: '{}' }), ops.env, ops.exec)
			expect(refused.status).toBe(404)
			expect(ops.loads).toBe(0)
			expect(ops.clients).toEqual([])
		}),
	)

	test(
		"a mutation's ctx.kick writes its wake and runs nothing in the Worker; the object hears of it once, after the commit",
		inProcess(async () => {
			const target = deploy()
			const before = Date.now()
			expect((await call(target, 'create', { workspaceId: 'w1', title: 'first' })).status).toBe(200)
			await target.settled()
			expect(target.world.runs).toEqual([])
			expect(await rows<{ reason: string }>(`select reason from ${SCHEMA}.fabrika_wakes where job = 'tally'`)).toEqual([{ reason: 'kick' }])
			const notices = target.sent.filter((request) => new URL(request.url).pathname === WAKE_PATH)
			expect(notices).toHaveLength(1)
			expect(notices[0]?.method).toBe('POST')
			expect(notices[0]?.headers.get(WAKE_DELAY_HEADER)).toBe('0')
			// The object's alarm is lowered to the wake: due now.
			expect(target.state.alarm).not.toBeNull()
			expect(target.state.alarm ?? 0).toBeGreaterThanOrEqual(before)
			expect(target.state.alarm ?? 0).toBeLessThanOrEqual(Date.now())

			// A read changes no wake and tells the object nothing.
			expect((await call(target, 'titles', { workspaceId: 'w1' })).status).toBe(200)
			await target.settled()
			expect(target.sent.filter((request) => new URL(request.url).pathname === WAKE_PATH)).toHaveLength(1)
		}),
	)

	test(
		'tells the object only once the work that wrote the wake settled',
		inProcess(async () => {
			const target = deploy()
			const notice = gate()
			target.holdObject = notice
			expect((await call(target, 'create', { workspaceId: 'w1', title: 'first' })).status).toBe(200)
			await notice.reached
			// The notice is under way and the request's client still open: it ends after the notice.
			expect(target.clients[0]?.ended).toBe(false)
			notice.open()
			await target.settled()
			expect(target.clients[0]?.ended).toBe(true)
		}),
	)
})

describe.skipIf(!hasPostgres)('public procedures on the Worker', () => {
	test(
		'an isolate serves two anonymous calls at once; the share of the third is full',
		inProcess(async () => {
			const target = deploy()
			const held = gate()
			target.world.hold = held.wait
			const path = '/api/notes.ping'
			const ping = () =>
				target.worker.fetch(
					new Request(`${ORIGIN}${path}`, {
						method: 'POST',
						headers: {
							'X-Fabrika-Endpoint': endpointHeaderFor(target.served.implementation, 'POST', path) ?? '',
							'Content-Type': 'application/json',
							'Sec-Fetch-Site': 'same-origin',
						},
						body: '{}',
					}),
					target.env,
					target.exec,
				)
			const log = spyOn(console, 'error').mockImplementation(() => {})
			try {
				const first = ping()
				await held.reached
				const second = ping()
				// The share is two per isolate, as on the SQLite object: each event opens its own client, so no pool of the
				// isolate is shared with staff.
				expect((await ping()).status).toBe(503)
				held.open()
				expect(await (await first).json()).toEqual({ result: { pong: true } })
				expect(await (await second).json()).toEqual({ result: { pong: true } })
				await target.settled()
			} finally {
				log.mockRestore()
			}
		}),
	)
})

describe.skipIf(!hasPostgres)('the boot of an isolate', () => {
	test(
		'without the Hyperdrive binding fails before it loads the application, and is reported once without the URL',
		inProcess(async () => {
			const envelopes: string[] = []
			const target = deploy({
				vars: { [CLOUDFLARE_DATABASE_BINDING]: undefined, FABRIKA_OPERATIONS_DSN: DSN },
				operationsFetch: async (request) => {
					envelopes.push(await request.text())
					return new Response(null, { status: 202 })
				},
			})
			await expect(call(target, 'titles', { workspaceId: 'w1' })).rejects.toThrow('the FABRIKA_DATABASE Hyperdrive binding is missing')
			await target.settled()
			expect(target.loads).toBe(0)
			expect(target.clients).toEqual([])
			expect(envelopes).toHaveLength(1)
			expect(envelopes[0]).toContain('boot_failed')
			expect(envelopes[0]).not.toContain(runtimeUrl)
		}),
	)

	test(
		'that failed boots again only once its backoff passed, which doubles, and is reported once per streak',
		inProcess(async () => {
			const envelopes: string[] = []
			const target = deploy({
				// Refused after the application loaded: the schema is read from the application environment id.
				vars: { FABRIKA_IAM_APP_ID: 'no-environment', FABRIKA_OPERATIONS_DSN: DSN },
				operationsFetch: async (request) => {
					envelopes.push(await request.text())
					return new Response(null, { status: 202 })
				},
			})
			const refused = () => expect(call(target, 'titles', { workspaceId: 'w1' })).rejects.toThrow('is not an application environment id')
			const start = Date.now()
			try {
				setSystemTime(start)
				await refused()
				expect(target.loads).toBe(1)
				// Within the first backoff (1 s) no event boots again.
				setSystemTime(start + 999)
				await refused()
				expect(target.loads).toBe(1)
				setSystemTime(start + 1_000)
				await refused()
				expect(target.loads).toBe(2)
				// The second failure doubled it to 2 s.
				setSystemTime(start + 2_999)
				await refused()
				expect(target.loads).toBe(2)
				setSystemTime(start + 3_000)
				await refused()
				expect(target.loads).toBe(3)
			} finally {
				setSystemTime()
			}
			await target.settled()
			expect(envelopes).toHaveLength(1)
			expect(envelopes[0]).toContain('boot_failed')
		}),
	)
})

describe.skipIf(!hasPostgres)('the job object', () => {
	test(
		'answers nothing without the proxy secret, refuses ops, and knows no other path',
		inProcess(async () => {
			const target = deploy()
			for (
				const request of [
					new Request(`https://application.invalid${WAKE_PATH}`, { method: 'POST', headers: { [WAKE_DELAY_HEADER]: '0' } }),
					new Request(`https://application.invalid${WAKE_PATH}`, {
						method: 'POST',
						headers: { [PROXY_SECRET_HEADER]: 'wrong', [WAKE_DELAY_HEADER]: '0' },
					}),
					new Request('https://application.invalid/', { method: 'POST', headers: { [TICK_HEADER]: '1' } }),
				]
			) {
				const response = await target.object.fetch(request)
				expect(response.status).toBe(404)
				expect(await response.text()).toBe('')
			}
			expect(target.state.alarm).toBeNull()
			expect((await target.object.fetch(fromWorker(`${OPS_PREFIX}state`))).status).toBe(404)
			expect((await target.object.fetch(fromWorker('/api/notes.titles'))).status).toBe(404)
			expect(target.loads).toBe(0)
			expect(target.clients).toEqual([])
		}),
	)

	test(
		'a wake notice lowers the alarm and never raises it',
		inProcess(async () => {
			const target = deploy()
			const now = Date.now()
			expect((await target.object.fetch(fromWorker(WAKE_PATH, { [WAKE_DELAY_HEADER]: '20000' }))).status).toBe(204)
			expect(target.state.alarm ?? 0).toBeGreaterThanOrEqual(now + 20_000)
			const armed = target.state.alarm
			expect((await target.object.fetch(fromWorker(WAKE_PATH, { [WAKE_DELAY_HEADER]: '50000' }))).status).toBe(204)
			expect(target.state.alarm).toBe(armed)
			expect((await target.object.fetch(fromWorker(WAKE_PATH, { [WAKE_DELAY_HEADER]: '1000' }))).status).toBe(204)
			expect(target.state.alarm ?? Number.POSITIVE_INFINITY).toBeLessThan(armed ?? 0)
			for (const delay of ['', '-1', '1.5', 'soon', '12345678901234567']) {
				expect((await target.object.fetch(fromWorker(WAKE_PATH, { [WAKE_DELAY_HEADER]: delay }))).status).toBe(400)
			}
			// Many notices at once: the alarm ends at the earliest of them.
			const base = Date.now()
			await Promise.all([900, 300, 700, 500].map((delay) => target.object.fetch(fromWorker(WAKE_PATH, { [WAKE_DELAY_HEADER]: String(delay) }))))
			expect(target.state.alarm ?? 0).toBeGreaterThanOrEqual(base + 300)
			expect(target.state.alarm ?? 0).toBeLessThan(base + 500)
			expect(target.loads).toBe(0)
		}),
	)

	test(
		'one alarm runs the kicked job and arms the next alarm ahead, not at the wake it just took',
		inProcess(async () => {
			const target = deploy()
			expect((await call(target, 'create', { workspaceId: 'w1', title: 'first' })).status).toBe(200)
			await target.settled()
			// As workerd does, the alarm that fires is gone while its handler runs.
			target.state.alarm = null
			await target.object.alarm()
			await target.settled()
			expect(target.world.runs).toEqual([{ job: 'tally', notes: 1 }])
			expect(target.state.alarm ?? 0).toBeGreaterThan(Date.now())
			expect(target.state.alarm ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now() + POSTGRES_ALARM_REFRESH_MS)
		}),
	)

	test(
		'its alarm runs a due job under its lease, starts no second run while the lease is held, and re-arms within the refresh',
		inProcess(async () => {
			const target = deploy()
			expect((await call(target, 'create', { workspaceId: 'w1', title: 'first' })).status).toBe(200)
			await target.settled()
			const held = gate()
			target.world.hold = () => {
				target.world.hold = undefined
				return held.wait()
			}
			const log = spyOn(console, 'error')
			await target.object.alarm()
			await held.reached
			const [lease] = await rows<{ holder: string | null }>(`select holder from ${SCHEMA}.fabrika_job_leases where job = 'tally'`)
			expect(lease?.holder).not.toBeNull()
			// A second alarm while the run holds the lease starts nothing.
			await target.object.alarm()
			held.open()
			await target.settled()
			// The startup repair and the run went through without a failure.
			const failures = log.mock.calls.length
			log.mockRestore()
			expect(failures).toBe(0)
			expect(target.world.runs).toEqual([{ job: 'tally', notes: 1 }])
			expect(await rows(`select reason from ${SCHEMA}.fabrika_wakes where job = 'tally' and reason = 'kick'`)).toEqual([])
			const [free] = await rows<{ holder: string | null }>(`select holder from ${SCHEMA}.fabrika_job_leases where job = 'tally'`)
			expect(free?.holder).toBeNull()
			// The startup repair scheduled the cron wake at 03:00; the alarm is the refresh, at most a minute ahead.
			expect(await rows(`select reason from ${SCHEMA}.fabrika_wakes where job = 'tally'`)).toEqual([{ reason: 'cron' }])
			expect(target.state.alarm ?? 0).toBeGreaterThan(Date.now())
			expect(target.state.alarm ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now() + POSTGRES_ALARM_REFRESH_MS)
			expect(target.clients.every((client) => client.ended)).toBe(true)
		}),
	)

	test(
		'a wake nothing projected is found by the next alarm, which arms at it',
		inProcess(async () => {
			const target = deploy()
			await target.object.alarm()
			await target.settled()
			const due = Date.now() + 5_000
			// Written behind the framework's back, so nothing projected it: the alarm's refresh is what finds it.
			await admin((sql) =>
				sql.unsafe(`insert into ${SCHEMA}.fabrika_wakes (id, job, due_at, reason) values (gen_random_uuid(), 'tally', ${due}, 'claim')`)
			)
			expect(target.state.alarm ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now() + POSTGRES_ALARM_REFRESH_MS)
			target.state.alarm = null
			await target.object.alarm()
			await target.settled()
			expect(target.state.alarm ?? 0).toBeGreaterThanOrEqual(due - 1_000)
			expect(target.state.alarm ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(due + 1_000)
		}),
	)

	test(
		'an internal error re-arms the alarm ALARM_RETRY_MS ahead, is reported, and does not throw',
		inProcess(async () => {
			const envelopes: string[] = []
			const target = deploy({
				vars: { FABRIKA_OPERATIONS_DSN: DSN },
				operationsFetch: async (request) => {
					envelopes.push(await request.text())
					return new Response(null, { status: 202 })
				},
			})
			target.broken = true
			const log = spyOn(console, 'error').mockImplementation(() => {})
			const before = Date.now()
			try {
				await target.object.alarm()
				await target.settled()
			} finally {
				log.mockRestore()
			}
			expect(target.state.alarm ?? 0).toBeGreaterThanOrEqual(before + ALARM_RETRY_MS)
			expect(target.state.alarm ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now() + ALARM_RETRY_MS)
			expect(envelopes.some((envelope) => envelope.includes('AlarmFailed'))).toBe(true)
			expect(envelopes.join('\n')).not.toContain(runtimeUrl)
			expect(target.clients.every((client) => client.ended)).toBe(true)

			// The next alarm, with the database back, runs normally and arms the refresh.
			target.broken = false
			target.state.alarm = null
			await target.object.alarm()
			await target.settled()
			expect(target.state.alarm ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now() + POSTGRES_ALARM_REFRESH_MS)
		}),
	)

	test(
		"the Worker's repair tick reconciles the cron wakes and arms the alarm",
		inProcess(async () => {
			const target = deploy()
			await target.worker.scheduled({ scheduledTime: Date.now(), cron: '* * * * *', noRetry: () => {} }, target.env, target.exec)
			await target.settled()
			const ticks = target.sent.filter((request) => request.headers.get(TICK_HEADER) !== null)
			expect(ticks).toHaveLength(1)
			expect(await rows(`select reason from ${SCHEMA}.fabrika_wakes where job = 'tally'`)).toEqual([{ reason: 'cron' }])
			expect(target.state.alarm ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(Date.now() + POSTGRES_ALARM_REFRESH_MS)
			// A malformed tick time is refused.
			expect((await target.object.fetch(fromWorker('/', { [TICK_HEADER]: 'noon' }))).status).toBe(400)
		}),
	)
})
