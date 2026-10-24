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
	OPS_ROW_ID,
	opsKeyDigest,
	opsRefusal,
	parseOpsContentView,
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
import { type ApplicationState, type ApplicationStorage, createContractWorker, FabrikaApplication, type ImplementationLoader } from '../cloudflare'
import { CLOUDFLARE_FILES_BINDING } from '../cloudflare/names'
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
}

async function start(
	options: { readonly load?: ImplementationLoader; readonly digests?: readonly [string] | readonly [string, string]; readonly alarm?: number } = {},
): Promise<Started> {
	const served = notesApp({ runs: [] })
	createContractWorker(options.load ?? (() => Promise.resolve({ default: served.implementation })), {
		migrations: await applicationMigrations(FIXTURE_ROOT),
	})
	const observed = observedStorage(options.alarm ?? null)
	const tokens = workloadTokensFor(served.implementation)
	const unused = () => Promise.reject(new Error('not called'))
	const state: ApplicationState = { storage: observed.storage, blockConcurrencyWhile: (callback) => callback(), waitUntil: () => {} }
	const object = new FabrikaApplication(state, {
		...frameworkEnvFor(served.implementation),
		...served.variables,
		FABRIKA_PROXY_SECRET: PROXY_SECRET,
		IAM: { getJwks: () => keySource.getJwks(), mintFromKey: (input: { app: string; key: string }) => tokens.exchange(input) },
		[CLOUDFLARE_FILES_BINDING]: { head: unused, get: unused, put: unused, delete: unused },
		[FABRIKA_OPS_KEY_DIGESTS]: formatOpsKeyDigests(options.digests ?? [opsKeyDigest(OPS_KEY)]),
		[FABRIKA_APPLICATION_OBJECT]: 'application',
		[FABRIKA_APPLICATION_OBJECTS]: 'application,clone',
	})
	return { ...observed, object }
}

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
			const { object, writes } = await start({ alarm })
			// Boots the application, which migrates the object's SQLite.
			expect((await object.fetch(new Request(`${ORIGIN}/healthz`, { headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET } }))).status).toBe(200)
			const before = { ...writes }
			const view = parseOpsView(await inspected(object))
			expect(writes).toEqual(before)
			expect(view).not.toBeNull()
			expect(view?.release).toBe(appPackage.version)
			expect(view?.maintenance).toEqual({ mode: 'open', generation: null, published: false })
			expect(view?.database.sizeBytes).toBeGreaterThan(0)
			expect(view?.database.tables).toContainEqual({ name: 'notes', rows: 0 })
			expect(view?.database.tables.some((table) => table.name.startsWith('sqlite_') || table.name.startsWith('_cf_'))).toBe(false)
			expect(view?.migrations.map((migration) => `${migration.bundle}/${migration.name}`)).toContain('app/20261022120000_notes.sql')
			expect(view?.scheduler).toEqual({ alarm: new Date(alarm).toISOString() })
			expect(view?.bootFailure).toBeNull()
		})
	})

	test('a broken boot is still inspectable; only the content view carries its message and stack', async () => {
		await keepingProcessEnvironment(async () => {
			const { object, writes } = await start({ load: () => Promise.reject(new Error('the module exploded while loading')) })
			await expect(object.fetch(new Request(`${ORIGIN}/healthz`, { headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET } }))).rejects.toThrow(
				'the module exploded while loading',
			)
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

	test("a boot failure's text is scrubbed of the environment's secrets", async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = await start({ load: () => Promise.reject(new Error(`could not use ${PROXY_SECRET}`)) })
			await expect(object.fetch(new Request(`${ORIGIN}/healthz`, { headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET } }))).rejects.toThrow()
			const content = JSON.stringify(await inspected(object, true))
			expect(content).not.toContain(PROXY_SECRET)
			expect(parseOpsContentView(JSON.parse(content))?.bootFailure?.message).toBe('could not use [redacted]')
		})
	})

	test('state and migrate are authenticated, then answered as not implemented', async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = await start()
			for (
				const request of [
					opsRequest('state', { object: 'application', generation: 1, mode: 'read-only' }),
					opsRequest('migrate', { object: 'application', generation: 1 }),
				]
			) {
				const response = await object.fetch(request)
				expect(response.status).toBe(501)
				expect(await response.json()).toEqual({ refused: 'not_implemented' })
			}
			const unauthenticated = await object.fetch(
				opsRequest('state', { object: 'application', generation: 1, mode: 'read-only' }, { key: 'wrong-key-0123456789' }),
			)
			expect(unauthenticated.status).toBe(404)
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
