// Control's ops channel at the environment object (ADR-0069 §1, §2): the object authenticates the caller before it
// looks at the request's detail, answers every refusal the same, and serves the view from its storage alone, also when
// the application cannot boot. Each object is constructed directly, as workerd constructs it, over bun:sqlite.

import {
	ENDPOINT_HEADER,
	FABRIKA_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECTS,
	FABRIKA_OPS_KEY_DIGESTS,
	formatEndpointHeader,
	formatOpsKeyDigests,
	OPS_DATA_REFUSED_STATUS,
	OPS_ROW_ID,
	opsKeyDigest,
	opsRefusal,
	parseOpsContentView,
	parseOpsDataRefusal,
	parseOpsView,
	PROXY_SECRET_HEADER,
	requirementDigest,
} from '@fabrika/auth-core'
import { Database as BunDatabase } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import appPackage from '../../package.json' with { type: 'json' }
import { applicationMigrations } from '../build'
import {
	type ApplicationState,
	type ApplicationStorage,
	type ContractWorker,
	createContractWorker,
	FabrikaApplication,
	type ImplementationLoader,
} from '../cloudflare'
import { TICK_HEADER } from '../cloudflare/application'
import { IMPORT_MARKER_KEY } from '../cloudflare/import'
import { MaintenanceBarrier } from '../cloudflare/maintenance'
import { CLOUDFLARE_APPLICATION_BINDING, CLOUDFLARE_FILES_BINDING } from '../cloudflare/names'
import { opsAccess, type OpsTarget, serveOps } from '../cloudflare/ops'
import { notesApp } from './cloudflare-fixture/src/app'
import { frameworkEnvFor, keepingProcessEnvironment, keySource, ORIGIN, PROXY_SECRET, workloadTokensFor } from './fixtures/implement/harness'

const FIXTURE_ROOT = join(import.meta.dir, 'cloudflare-fixture')
const OPS_KEY = 'ops-key-of-the-environment-0123456789abcdef'
const NEXT_OPS_KEY = 'ops-key-after-the-rotation-0123456789abcdef'

/** The composed row as ADR-0022 rule 3 fixes it, built here from its fields so a drift of the object's copy shows. */
const OPS_ENDPOINT = formatEndpointHeader(
	OPS_ROW_ID,
	requirementDigest({
		kind: 'protocol',
		method: 'POST',
		path: '/__fabrika/ops/*',
		callers: [],
		requirement: null,
		admission: { contentTypes: ['application/json'], maxBytes: 64 * 1024 },
		oauth: null,
		delegation: null,
	}),
)

interface Observed {
	readonly storage: ApplicationStorage
	readonly database: BunDatabase
	/** Rows every statement reported written, and the transactions opened, since the object started. */
	readonly writes: { rows: number; transactions: number }
}

/** bun:sqlite as the object's storage, with the size and the alarm workerd's storage has, and every write counted. */
function observedStorage(alarm: number | null = null): Observed {
	const database = new BunDatabase(':memory:')
	const inner = bunSqliteStorage(database)
	const writes = { rows: 0, transactions: 0 }
	const storage: ApplicationStorage = {
		sql: {
			exec(query, ...bindings) {
				const cursor = inner.sql.exec(query, ...bindings)
				writes.rows += cursor.rowsWritten
				return cursor
			},
			get databaseSize() {
				return database.query<{ size: number }, []>('select page_count * page_size as size from pragma_page_count(), pragma_page_size()').get()?.size ?? 0
			},
		},
		transaction(closure) {
			writes.transactions++
			return inner.transaction(closure)
		},
		transactionSync(closure) {
			writes.transactions++
			return inner.transactionSync(closure)
		},
		getAlarm: () => Promise.resolve(alarm),
	}
	return { storage, database, writes }
}

interface Started extends Observed {
	readonly object: FabrikaApplication
	/** How often the application module was imported. */
	readonly loads: { count: number }
	readonly worker: ContractWorker
	readonly env: Readonly<Record<string, unknown>>
	/** What the object handed to `waitUntil`: the first event's startup repair among it. */
	readonly pending: Promise<unknown>[]
}

interface StartOptions {
	readonly load?: ImplementationLoader
	readonly digests?: readonly [string] | readonly [string, string]
	readonly alarm?: number
	/** Written straight into the database before the object exists, past the write counters. */
	readonly seed?: (database: BunDatabase) => void
}

/** A table SQLite allows and the wire's view does not name. */
const MIXED_CASE_TABLE = (database: BunDatabase) => database.run('CREATE TABLE "MixedCase" (id TEXT)')

async function start(options: StartOptions = {}): Promise<Started> {
	const served = notesApp({ runs: [] })
	const loads = { count: 0 }
	const load = options.load ?? (() => Promise.resolve({ default: served.implementation }))
	const worker = createContractWorker(() => {
		loads.count++
		return load()
	}, { migrations: await applicationMigrations(FIXTURE_ROOT) })
	const observed = observedStorage(options.alarm ?? null)
	options.seed?.(observed.database)
	const tokens = workloadTokensFor(served.implementation)
	const unused = () => Promise.reject(new Error('not called'))
	const pending: Promise<unknown>[] = []
	const state: ApplicationState = {
		storage: observed.storage,
		blockConcurrencyWhile: (callback) => callback(),
		waitUntil: (promise) => void pending.push(promise),
	}
	const env = {
		...frameworkEnvFor(served.implementation),
		...served.variables,
		FABRIKA_PROXY_SECRET: PROXY_SECRET,
		IAM: { getJwks: () => keySource.getJwks(), mintFromKey: (input: { app: string; key: string }) => tokens.exchange(input) },
		// No maintenance state, so the object reads `open`; no file call is expected.
		[CLOUDFLARE_FILES_BINDING]: {
			head: unused,
			get: (key: string) => key.startsWith('__fabrika/ops/') ? Promise.resolve(null) : unused(),
			put: unused,
			delete: unused,
		},
		[FABRIKA_OPS_KEY_DIGESTS]: formatOpsKeyDigests(options.digests ?? [opsKeyDigest(OPS_KEY)]),
		[FABRIKA_APPLICATION_OBJECT]: 'application',
		[FABRIKA_APPLICATION_OBJECTS]: 'application,clone',
	}
	return { ...observed, object: new FabrikaApplication(state, env), loads, worker, env, pending }
}

const health = () => new Request(`${ORIGIN}/healthz`, { headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET } })

interface OpsInit {
	readonly key?: string | null
	readonly endpoint?: string | null
	readonly method?: string
	readonly body?: string
}

/** An ops request as the Worker forwards it: the proxy secret, the ops row's endpoint header and Control's key. */
function opsRequest(operation: string, body: unknown, init: OpsInit = {}): Request {
	const key = init.key === undefined ? OPS_KEY : init.key
	const endpoint = init.endpoint === undefined ? OPS_ENDPOINT : init.endpoint
	const headers = new Headers({ [PROXY_SECRET_HEADER]: PROXY_SECRET, 'Content-Type': 'application/json' })
	if (key !== null) headers.set('Authorization', `Bearer ${key}`)
	if (endpoint !== null) headers.set(ENDPOINT_HEADER, endpoint)
	return new Request(`${ORIGIN}/__fabrika/ops/${operation}`, { method: init.method ?? 'POST', headers, body: init.body ?? JSON.stringify(body) })
}

const INSPECT = { object: 'application', content: false }
const INSPECT_CONTENT = { object: 'application', content: true }

/** Everything a caller can observe of an answer. */
async function observable(response: Response) {
	return { status: response.status, headers: [...response.headers.entries()], body: await response.text() }
}

async function inspected(object: FabrikaApplication, content = false): Promise<unknown> {
	const response = await object.fetch(opsRequest('inspect', content ? INSPECT_CONTENT : INSPECT))
	expect(response.status).toBe(200)
	return await response.json()
}

describe('the ops channel at the environment object', () => {
	test('every refusal inside the prefix is the same answer, byte for byte', async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = await start()
			const refusal = await observable(opsRefusal())
			const refused = [
				opsRequest('inspect', INSPECT, { key: 'not-the-ops-key-0123456789abcdef' }),
				opsRequest('inspect', INSPECT, { key: null }),
				opsRequest('inspect', INSPECT, { endpoint: null }),
				opsRequest('inspect', INSPECT, { endpoint: formatEndpointHeader(OPS_ROW_ID, opsKeyDigest('another row')) }),
				opsRequest('inspect', INSPECT, { endpoint: formatEndpointHeader('notes.list', OPS_ENDPOINT.slice(OPS_ENDPOINT.indexOf('@') + 1)) }),
				opsRequest('backup', INSPECT),
				opsRequest('inspect', { object: 'elsewhere', content: false }),
				opsRequest('inspect', { object: 'application' }),
				opsRequest('inspect', null, { body: '{not json' }),
				opsRequest('inspect', INSPECT, { method: 'PUT' }),
			]
			for (const request of refused) {
				expect(await observable(await object.fetch(request))).toEqual(refusal)
			}
			expect(refusal).toEqual({ status: 404, headers: [], body: '' })
		})
	})

	test('a right key under a wrong endpoint header is refused', async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = await start()
			const response = await object.fetch(opsRequest('inspect', INSPECT, { endpoint: formatEndpointHeader(OPS_ROW_ID, opsKeyDigest('x')) }))
			expect(await observable(response)).toEqual(await observable(opsRefusal()))
		})
	})

	test('the key is accepted from either digest while a rotation reconciles', async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = await start({ digests: [opsKeyDigest(OPS_KEY), opsKeyDigest(NEXT_OPS_KEY)] })
			for (const key of [OPS_KEY, NEXT_OPS_KEY]) {
				expect((await object.fetch(opsRequest('inspect', INSPECT, { key }))).status).toBe(200)
			}
			expect((await object.fetch(opsRequest('inspect', INSPECT, { key: `${OPS_KEY}x` }))).status).toBe(404)
		})
	})

	test("inspect serves the projection of the object's storage, and writes nothing", async () => {
		await keepingProcessEnvironment(async () => {
			const alarm = Date.UTC(2026, 9, 24, 12, 0, 0)
			const { object, writes, pending } = await start({ alarm, seed: MIXED_CASE_TABLE })
			// Boots the application, which migrates the object's SQLite, and repairs the jobs' wakes past the answer.
			expect((await object.fetch(health())).status).toBe(200)
			await Promise.all(pending)
			const before = { ...writes }
			const view = parseOpsView(await inspected(object))
			expect(writes).toEqual(before)
			expect(view).not.toBeNull()
			expect(view?.release).toBe(appPackage.version)
			expect(view?.maintenance).toEqual({ mode: 'open', generation: null, published: false })
			expect(view?.database.sizeBytes).toBeGreaterThan(0)
			expect(view?.database.tables).toContainEqual({ name: 'notes', rows: 0 })
			expect(view?.database.tables.some((table) => table.name.startsWith('sqlite_') || table.name.startsWith('_cf_'))).toBe(false)
			expect(view?.database.tables.some((table) => table.name === 'MixedCase')).toBe(false)
			expect(view?.migrations.map((migration) => `${migration.bundle}/${migration.name}`)).toContain('app/20261022120000_notes.sql')
			expect(view?.scheduler).toEqual({ alarm: new Date(alarm).toISOString() })
			expect(view?.bootFailure).toBeNull()
		})
	})

	test('a broken boot is still inspectable; only the content view carries its message and stack', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, writes } = await start({ load: () => Promise.reject(new Error('the module exploded while loading')), seed: MIXED_CASE_TABLE })
			await expect(object.fetch(health())).rejects.toThrow('the module exploded while loading')
			const before = { ...writes }
			const projection = await inspected(object)
			const view = parseOpsView(projection)
			expect(view?.bootFailure).toEqual({ at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) })
			expect(JSON.stringify(projection)).not.toContain('exploded')
			expect(view?.database.tables).toEqual([])
			expect(view?.migrations).toEqual([])

			const content = parseOpsContentView(await inspected(object, true))
			expect(content?.bootFailure?.message).toBe('the module exploded while loading')
			expect(content?.bootFailure?.stack).toContain('exploded')
			expect(content?.bootFailure?.at).toBe(view?.bootFailure?.at ?? '')
			expect(writes).toEqual(before)
		})
	})

	test('a boot that succeeds after a failed one clears the failure from the view', async () => {
		await keepingProcessEnvironment(async () => {
			const served = notesApp({ runs: [] })
			let attempts = 0
			const { object, loads } = await start({
				load: () => attempts++ === 0 ? Promise.reject(new Error('a transient failure')) : Promise.resolve({ default: served.implementation }),
			})
			await expect(object.fetch(health())).rejects.toThrow('a transient failure')
			expect(parseOpsView(await inspected(object))?.bootFailure).not.toBeNull()
			// Past the first failure's backoff the next event boots again, and this time it boots.
			await Bun.sleep(1_050)
			expect((await object.fetch(health())).status).toBe(200)
			expect(loads.count).toBe(2)
			expect(parseOpsView(await inspected(object))?.bootFailure).toBeNull()
		})
	})

	test("a boot failure's text is scrubbed of the environment's secrets", async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = await start({ load: () => Promise.reject(new Error(`could not use ${PROXY_SECRET}`)) })
			await expect(object.fetch(health())).rejects.toThrow()
			const content = JSON.stringify(await inspected(object, true))
			expect(content).not.toContain(PROXY_SECRET)
			expect(parseOpsContentView(JSON.parse(content))?.bootFailure?.message).toBe('could not use [redacted]')
		})
	})

	test('state and migrate are authenticated before the barrier answers them', async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = await start()
			const transition = { object: 'application', generation: 1, mode: 'read-only' }
			expect(await observable(await object.fetch(opsRequest('state', transition, { key: 'wrong-key-0123456789' })))).toEqual(
				await observable(opsRefusal()),
			)
			expect(await observable(await object.fetch(opsRequest('migrate', { object: 'application', generation: 1 }, { key: null })))).toEqual(
				await observable(opsRefusal()),
			)
			// This bucket refuses every put: the transition fails, so Control retries it.
			expect((await object.fetch(opsRequest('state', transition))).status).toBe(503)
			const migrate = await object.fetch(opsRequest('migrate', { object: 'application', generation: 1 }))
			expect(migrate.status).toBe(409)
			expect(await migrate.json()).toEqual({ refused: 'stale_generation', published: null })
		})
	})

	test('an object without ops key digests refuses every ops request', async () => {
		await keepingProcessEnvironment(async () => {
			const served = notesApp({ runs: [] })
			createContractWorker(() => Promise.resolve({ default: served.implementation }), { migrations: await applicationMigrations(FIXTURE_ROOT) })
			const { storage } = observedStorage()
			const object = new FabrikaApplication({ storage, blockConcurrencyWhile: (callback) => callback(), waitUntil: () => {} }, {
				...frameworkEnvFor(served.implementation),
				...served.variables,
				FABRIKA_PROXY_SECRET: PROXY_SECRET,
			})
			expect(await observable(await object.fetch(opsRequest('inspect', INSPECT)))).toEqual(await observable(opsRefusal()))
		})
	})
})

describe('an ops request never boots the application', () => {
	test('a cold instance refuses a wrong key without loading the application or writing', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, loads, writes } = await start()
			const response = await object.fetch(opsRequest('inspect', INSPECT, { key: 'not-the-ops-key-0123456789abcdef' }))
			expect(await observable(response)).toEqual(await observable(opsRefusal()))
			expect(loads.count).toBe(0)
			expect(writes).toEqual({ rows: 0, transactions: 0 })
		})
	})

	test('a cold instance serves the view from storage alone, without loading the application or writing', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, loads, writes } = await start({ seed: MIXED_CASE_TABLE })
			const view = parseOpsView(await inspected(object))
			expect(view?.database.tables).toEqual([])
			expect(view?.migrations).toEqual([])
			expect(view?.bootFailure).toBeNull()
			expect(loads.count).toBe(0)
			expect(writes).toEqual({ rows: 0, transactions: 0 })
		})
	})

	test('inspect waits for a boot under way and starts no retry after it fails', async () => {
		await keepingProcessEnvironment(async () => {
			const loading = Promise.withResolvers<void>()
			const { object, loads } = await start({
				load: async () => {
					await loading.promise
					throw new Error('the module failed late')
				},
			})
			const ordinary = object.fetch(health())
			const inspection = object.fetch(opsRequest('inspect', INSPECT))
			let answered = false
			void inspection.then(() => {
				answered = true
			})
			await Bun.sleep(20)
			expect(answered).toBe(false)
			loading.resolve()
			await expect(ordinary).rejects.toThrow('the module failed late')
			const view = parseOpsView(await (await inspection).json())
			expect(view?.bootFailure).toEqual({ at: expect.stringMatching(/^\d{4}-/) })
			expect(parseOpsView(await inspected(object))?.bootFailure).not.toBeNull()
			expect(loads.count).toBe(1)
		})
	})

	test('ordinary traffic boots the application once, however many requests arrive together', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, loads } = await start()
			const answers = await Promise.all([object.fetch(health()), object.fetch(health()), object.fetch(health())])
			expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200])
			expect((await object.fetch(health())).status).toBe(200)
			expect(loads.count).toBe(1)
		})
	})

	test('the repair tick boots a cold instance', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, loads } = await start()
			const tick = new Request(`${ORIGIN}/`, {
				method: 'POST',
				headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET, [TICK_HEADER]: String(Date.UTC(2026, 9, 24, 12, 7)) },
			})
			expect((await object.fetch(tick)).status).toBe(204)
			expect(loads.count).toBe(1)
		})
	})
})

describe('the Worker authenticates an ops request before it selects an object', () => {
	/** The environment's object namespace, recording every name it is asked for. */
	function countingNamespace() {
		const lookups: string[] = []
		const namespace = {
			idFromName(name: string) {
				lookups.push(name)
				return name
			},
			get: (id: unknown) => ({ fetch: () => Promise.resolve(new Response(`object ${String(id)}`)) }),
		}
		return { lookups, namespace }
	}

	/** What the proxy Worker sends: no proxy secret, which the application's Worker adds itself. */
	function fromProxy(operation: string, body: unknown, init: OpsInit = {}): Request {
		const request = opsRequest(operation, body, init)
		const headers = new Headers(request.headers)
		headers.delete(PROXY_SECRET_HEADER)
		return new Request(request, { headers })
	}

	const exec = { waitUntil: () => {}, passThroughOnException: () => {} }

	test('a missing or wrong credential looks no object up, whether the name is listed or not', async () => {
		await keepingProcessEnvironment(async () => {
			const { worker, env } = await start()
			const { lookups, namespace } = countingNamespace()
			const workerEnv = { ...env, [CLOUDFLARE_APPLICATION_BINDING]: namespace }
			const refusal = await observable(opsRefusal())
			for (const object of ['application', 'elsewhere']) {
				for (
					const init of [
						{ key: null },
						{ key: 'not-the-ops-key-0123456789abcdef' },
						{ endpoint: null },
						{ endpoint: formatEndpointHeader(OPS_ROW_ID, opsKeyDigest('another row')) },
						{ method: 'PUT' },
					]
				) {
					const response = await worker.fetch(fromProxy('inspect', { object, content: false }, init), workerEnv, exec)
					expect(await observable(response)).toEqual(refusal)
				}
			}
			expect(lookups).toEqual([])
			const admitted = await worker.fetch(fromProxy('inspect', { object: 'clone', content: false }), workerEnv, exec)
			expect(await admitted.text()).toBe('object clone')
			expect(lookups).toEqual(['clone'])
		})
	})
})

describe('a transition of an object that holds an import marker', () => {
	const ACCESS = opsAccess({
		[FABRIKA_OPS_KEY_DIGESTS]: formatOpsKeyDigests([opsKeyDigest(OPS_KEY)]),
		[FABRIKA_APPLICATION_OBJECT]: 'application',
		[FABRIKA_APPLICATION_OBJECTS]: 'application,clone',
	})

	/** A clone's storage with workerd's synchronous KV, and its barrier published `inspect` at 3 over a bucket that takes every put. */
	async function clone(): Promise<{ readonly target: OpsTarget; readonly kv: Map<string, unknown>; readonly barrier: MaintenanceBarrier }> {
		const kv = new Map<string, unknown>()
		const storage = {
			...bunSqliteStorage(new BunDatabase(':memory:')),
			kv: {
				get: (key: string) => kv.get(key),
				put: (key: string, value: unknown) => {
					kv.set(key, value)
				},
				delete: (key: string) => kv.delete(key),
			},
		}
		const barrier = await MaintenanceBarrier.load({
			read: () => Promise.resolve({ state: { generation: 3, mode: 'inspect' }, version: 'v3' }),
			put: (state) => Promise.resolve(`v${state.generation}`),
		})
		const target: OpsTarget = {
			storage,
			bucket: null,
			recovery: null,
			contractDigest: null,
			migrations: [],
			bootFailure: () => Promise.resolve(null),
			maintenance: () => Promise.resolve(barrier),
			migrate: () => Promise.reject(new Error('not called')),
		}
		return { target, kv, barrier }
	}

	function transition(generation: number, mode: string): Request {
		return opsRequest('state', { object: 'clone', generation, mode })
	}

	test('no transition leaves inspect while the marker is there; another inspect generation is acknowledged', async () => {
		const { target, kv, barrier } = await clone()
		kv.set(IMPORT_MARKER_KEY, '{}')

		for (const mode of ['open', 'read-only', 'closed']) {
			const response = await serveOps(transition(4, mode), ACCESS, target)
			expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
			expect(parseOpsDataRefusal(await response.json())).toEqual({ refused: 'wrong_mode', table: null })
		}
		expect(barrier.view()).toEqual({ mode: 'inspect', generation: 3, published: true })
		expect((await serveOps(transition(4, 'inspect'), ACCESS, target)).status).toBe(200)

		kv.delete(IMPORT_MARKER_KEY)
		expect((await serveOps(transition(5, 'open'), ACCESS, target)).status).toBe(200)
		expect(barrier.view()).toEqual({ mode: 'open', generation: 5, published: true })
	})

	test("the marker is read in the barrier's turn, after a data step that writes it", async () => {
		const { target, kv, barrier } = await clone()
		const writing = Promise.withResolvers<void>()
		const begun = barrier.step(3, async () => {
			await writing.promise
			kv.set(IMPORT_MARKER_KEY, '{}')
			return { value: null, holdUntil: null }
		})

		const opening = serveOps(transition(4, 'open'), ACCESS, target)
		// The request reaches the barrier and queues behind the step before the step writes the marker.
		const waited = await Promise.race([opening.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20))])
		expect(waited).toBe(false)
		writing.resolve()
		await begun

		expect((await opening).status).toBe(OPS_DATA_REFUSED_STATUS)
		expect(barrier.view()).toEqual({ mode: 'inspect', generation: 3, published: true })
	})
})
