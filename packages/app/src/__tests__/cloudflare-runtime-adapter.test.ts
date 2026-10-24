// What the environment object boots with besides its database: the IAM binding (keys and membership), the SPA's
// assets and the crash reports of its isolate; and that two objects of one isolate each keep their own database. Each
// object is constructed directly, as workerd constructs it.

import { defineContract } from '@fabrika/app/contract'
import { PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import { Database as BunDatabase } from 'bun:sqlite'
import { describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import { applicationMigrations } from '../build'
import { type ApplicationState, type ApplicationStorage, type ContractWorkerOptions, createContractWorker, FabrikaApplication } from '../cloudflare'
import { TICK_HEADER } from '../cloudflare/application'
import { CLOUDFLARE_FILES_BINDING } from '../cloudflare/names'
import { FILE_SWEEP_JOB } from '../files/kinds'
import type { CrashEvents, ProcessCrashKind } from '../implement/crashes'
import type { ContractImplementation } from '../implement/implement'
import { implement } from '../implement/implement'
import { notesApp as sqliteNotesApp } from './cloudflare-fixture/src/app'
import type { NotesWorld } from './cloudflare-fixture/src/world'
import { notesApp } from './fixtures/implement/app'
import {
	endpointHeaderFor,
	frameworkEnvFor,
	grant,
	keepingProcessEnvironment,
	keySource,
	ORIGIN,
	PROXY_SECRET,
	token,
	workloadTokensFor,
} from './fixtures/implement/harness'

const FIXTURE_ROOT = join(import.meta.dir, 'cloudflare-fixture')
const DSN = 'https://0123456789abcdef0123456789abcdef@operations.test/42'

interface Started {
	readonly object: FabrikaApplication
	/** What the object handed to `waitUntil`. */
	readonly pending: Promise<unknown>[]
}

/** A fresh object of `implementation`, as the Worker's environment constructs one, with `env` added to its variables. */
function start(implementation: ContractImplementation, env: Readonly<Record<string, unknown>>, options: ContractWorkerOptions = {}): Started {
	createContractWorker(() => Promise.resolve({ default: implementation }), options)
	const pending: Promise<unknown>[] = []
	const state: ApplicationState = {
		storage: bunSqliteStorage(),
		blockConcurrencyWhile: (callback) => callback(),
		waitUntil: (promise) => void pending.push(promise),
	}
	return { object: new FabrikaApplication(state, { ...frameworkEnvFor(implementation), FABRIKA_PROXY_SECRET: PROXY_SECRET, ...env }), pending }
}

/** A request as the Worker forwards it: the proxy's headers and the proxy secret. */
function forwarded(
	path: string,
	init: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string } = {},
): Request {
	return new Request(`${ORIGIN}${path}`, { ...init, headers: { ...init.headers, [PROXY_SECRET_HEADER]: PROXY_SECRET } })
}

describe('the environment object', () => {
	const assets = { fetch: (request: Request) => Promise.resolve(new Response(`asset ${new URL(request.url).pathname}`)) }
	const app = notesApp(new Map())

	test('serves through the IAM binding and the assets', async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = start(app, { IAM: keySource, ASSETS: assets })
			const response = await object.fetch(forwarded('/api/me', {
				method: 'POST',
				headers: {
					'X-Fabrika-Token': await token('user', [grant('notes.read')]),
					'X-Fabrika-Endpoint': endpointHeaderFor(app, 'POST', '/api/me') ?? '',
					'Content-Type': 'application/json',
					'Sec-Fetch-Site': 'same-origin',
				},
				body: '{}',
			}))
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ result: { id: 'user-1', label: 'user@notes.test' } })
			const page = await object.fetch(forwarded('/', {
				headers: { 'X-Fabrika-Token': await token('user', [grant('notes.read')]), 'X-Fabrika-Endpoint': endpointHeaderFor(app, 'GET', '/') ?? '' },
			}))
			expect(await page.text()).toBe('asset /')
		})
	})

	test('without the IAM binding it does not boot, and every request answers the failure', async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = start(notesApp(new Map()), { ASSETS: assets })
			await expect(object.fetch(forwarded('/healthz'))).rejects.toThrow('the IAM binding is missing')
			await expect(object.fetch(forwarded('/healthz'))).rejects.toThrow('the IAM binding is missing')
		})
	})
})

const starting = defineContract({
	app: 'notes',
	dimensions: { workspace: { creator: 'owner' } },
	actions: { 'notes.read': 'Read', 'workspaces.create': 'Start' },
	roles: { owner: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		start: c.mutation({ output: z.strictObject({ workspace: z.string() }), access: { action: 'workspaces.create', creates: 'workspace' } }),
	}),
}))
/** A contract that creates scopes, so it needs IAM's membership operations to boot. */
const startingApp = implement(starting, {
	database: null,
	deps: () => null,
	handlers: () => ({ api: { start: ({ ctx }) => ({ workspace: ctx.created.value }) } }),
})

describe('two environment objects in one isolate', () => {
	const WORKSPACE = { type: 'workspace', value: 'w1' }
	const unused = () => Promise.reject(new Error('not called'))

	test('each reads and writes only its own database, its waitUntil work included', async () => {
		await keepingProcessEnvironment(async () => {
			const world: NotesWorld = { runs: [] }
			const served = sqliteNotesApp(world)
			createContractWorker(() => Promise.resolve({ default: served.implementation }), { migrations: await applicationMigrations(FIXTURE_ROOT) })
			const tokens = workloadTokensFor(served.implementation)
			// While held, a job waits for its workload token, so A's job finishes after B's request.
			let held: Promise<void> = Promise.resolve()
			const hold = () => {
				const gate = Promise.withResolvers<void>()
				held = gate.promise
				return gate.resolve
			}
			const env = {
				...frameworkEnvFor(served.implementation),
				...served.variables,
				FABRIKA_PROXY_SECRET: PROXY_SECRET,
				IAM: {
					getJwks: () => keySource.getJwks(),
					mintFromKey: async (input: { app: string; key: string }) => {
						await held
						return await tokens.exchange(input)
					},
				},
				[CLOUDFLARE_FILES_BINDING]: { head: unused, get: unused, put: unused, delete: unused },
			}
			const objectOver = (storage: ApplicationStorage) => {
				const pending: Promise<unknown>[] = []
				const state: ApplicationState = { storage, blockConcurrencyWhile: (callback) => callback(), waitUntil: (promise) => void pending.push(promise) }
				return { object: new FabrikaApplication(state, env), pending }
			}
			const a = objectOver(bunSqliteStorage())
			const b = objectOver(bunSqliteStorage())
			const call = async (object: FabrikaApplication, procedure: string, input: unknown): Promise<unknown> => {
				const path = `/api/notes.${procedure}`
				const response = await object.fetch(forwarded(path, {
					method: 'POST',
					headers: {
						'X-Fabrika-Token': await token('user', [grant('notes.read', WORKSPACE), grant('notes.write', WORKSPACE)]),
						'X-Fabrika-Endpoint': endpointHeaderFor(served.implementation, 'POST', path) ?? '',
						'Content-Type': 'application/json',
						'Sec-Fetch-Site': 'same-origin',
					},
					body: JSON.stringify(input),
				}))
				expect(response.status).toBe(200)
				return await response.json()
			}

			await call(a.object, 'create', { workspaceId: 'w1', title: 'a-first' })
			await call(b.object, 'create', { workspaceId: 'w1', title: 'b-first' })
			expect(await call(a.object, 'titles', { workspaceId: 'w1' })).toEqual({ result: { titles: ['a-first'] } })
			await call(b.object, 'create', { workspaceId: 'w1', title: 'b-second' })
			expect(await call(b.object, 'titles', { workspaceId: 'w1' })).toEqual({ result: { titles: ['b-first', 'b-second'] } })

			const release = hold()
			const tick = await a.object.fetch(forwarded('/', { method: 'POST', headers: { [TICK_HEADER]: String(Date.UTC(2026, 9, 22, 3, 0, 0)) } }))
			expect(tick.status).toBe(204)
			await call(b.object, 'create', { workspaceId: 'w1', title: 'b-third' })
			expect(await call(b.object, 'titles', { workspaceId: 'w1' })).toEqual({ result: { titles: ['b-first', 'b-second', 'b-third'] } })
			expect(world.runs).toEqual([])
			release()
			await Promise.all(a.pending)
			expect(world.runs).toEqual([{ job: 'nightly', notes: 1 }])
			expect(await call(a.object, 'titles', { workspaceId: 'w1' })).toEqual({ result: { titles: ['a-first'] } })
		})
	})
})

describe('the minute tick of the environment object', () => {
	test('runs the due ones of exactly the jobs boot bound, the file sweep of a file kind included', async () => {
		await keepingProcessEnvironment(async () => {
			const served = sqliteNotesApp({ runs: [] })
			createContractWorker(() => Promise.resolve({ default: served.implementation }), { migrations: await applicationMigrations(FIXTURE_ROOT) })
			const tokens = workloadTokensFor(served.implementation)
			const unused = () => Promise.reject(new Error('not called'))
			const database = new BunDatabase(':memory:')
			const pending: Promise<unknown>[] = []
			const state: ApplicationState = {
				storage: bunSqliteStorage(database),
				blockConcurrencyWhile: (callback) => callback(),
				waitUntil: (promise) => void pending.push(promise),
			}
			const object = new FabrikaApplication(state, {
				...frameworkEnvFor(served.implementation),
				...served.variables,
				FABRIKA_PROXY_SECRET: PROXY_SECRET,
				IAM: { getJwks: () => keySource.getJwks(), mintFromKey: (input: { app: string; key: string }) => tokens.exchange(input) },
				[CLOUDFLARE_FILES_BINDING]: { head: unused, get: unused, put: unused, delete: unused },
			})
			const tickAt = async (time: number) => {
				const response = await object.fetch(forwarded('/', { method: 'POST', headers: { [TICK_HEADER]: String(time) } }))
				expect(response.status).toBe(204)
				await Promise.all(pending.splice(0))
			}
			const leases = () =>
				database.query<{ job: string; last_started_at: string | null }, []>('select job, last_started_at from fabrika_job_leases order by job').all()

			await tickAt(Date.UTC(2026, 9, 22, 3, 41, 0))
			expect(leases().map((row) => row.job)).toEqual(['fabrika-file-sweep', 'halfPast', 'nightly', 'putThenFail'].sort())
			expect(leases().filter((row) => row.last_started_at !== null).map((row) => row.job)).toEqual([FILE_SWEEP_JOB])
			await tickAt(Date.UTC(2026, 9, 22, 4, 30, 0))
			expect(leases().filter((row) => row.last_started_at !== null).map((row) => row.job).sort()).toEqual([FILE_SWEEP_JOB, 'halfPast'].sort())
		})
	})
})

describe('the environment object: IAM membership on the IAM binding', () => {
	const unused = () => Promise.reject(new Error('not called'))
	const binding = (createScope: (input: unknown) => Promise<unknown>) => ({
		...keySource,
		createScope,
		requestDelegation: unused,
		assignMember: unused,
		revokeMember: unused,
		listMembers: unused,
		issueLink: unused,
		revokeLink: unused,
	})
	const startRequest = async () =>
		forwarded('/api/start', {
			method: 'POST',
			headers: {
				'X-Fabrika-Token': await token('user', [grant('workspaces.create')]),
				'X-Fabrika-Endpoint': endpointHeaderFor(startingApp, 'POST', '/api/start') ?? '',
				'X-Fabrika-Delegation': 'grant-1',
				'Content-Type': 'application/json',
				'Sec-Fetch-Site': 'same-origin',
			},
			body: '{}',
		})

	test('asks IAM through the binding and decodes its answer', async () => {
		await keepingProcessEnvironment(async () => {
			const asked: unknown[] = []
			const createScope = (input: unknown) => {
				asked.push(input)
				return Promise.resolve({ ok: true, scope: { type: 'workspace', value: 'w9' }, role: 'owner' })
			}
			const { object } = start(startingApp, { IAM: binding(createScope) })
			expect(await (await object.fetch(await startRequest())).json()).toEqual({ result: { workspace: 'w9' } })
			expect(asked).toEqual([expect.objectContaining({ delegation: 'grant-1', dimension: 'workspace', app: 'notes@prod' })])
		})
	})

	test('an answer that breaks the contract is IAM unavailable, a 503', async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = start(startingApp, { IAM: binding(() => Promise.resolve({ ok: true, scope: 'w9' })) })
			const log = spyOn(console, 'error').mockImplementation(() => {})
			try {
				expect((await object.fetch(await startRequest())).status).toBe(503)
			} finally {
				log.mockRestore()
			}
		})
	})

	test('a binding without the membership operations does not boot a contract that needs them', async () => {
		await keepingProcessEnvironment(async () => {
			const { object } = start(startingApp, { IAM: keySource })
			await expect(object.fetch(await startRequest())).rejects.toThrow('the runtime adapter supplies no IAM membership transport')
		})
	})
})

function fakeEvents() {
	let listener: ((kind: ProcessCrashKind, error: unknown) => void) | null = null
	let listens = 0
	const events: CrashEvents = {
		listen(next) {
			listens++
			listener = next
			return () => {
				listener = null
			}
		},
	}
	return { events, fire: (kind: ProcessCrashKind, error: unknown) => listener?.(kind, error), listens: () => listens }
}

function capturingFetch() {
	const envelopes: string[] = []
	const fetch = async (request: Request): Promise<Response> => {
		envelopes.push(await request.text())
		return new Response(null, { status: 202 })
	}
	return { envelopes, fetch }
}

function tagsOf(envelope: string | undefined): unknown {
	const event: unknown = JSON.parse(envelope?.split('\n')[2] ?? 'null')
	return typeof event === 'object' && event !== null ? Reflect.get(event, 'tags') : null
}

describe('the crash reports of the environment object', () => {
	test("an isolate's first failed boot is reported once; once one booted, its rejections are reported", async () => {
		await keepingProcessEnvironment(async () => {
			const { envelopes, fetch } = capturingFetch()
			const source = fakeEvents()
			const options = { rejections: source.events, operationsFetch: fetch }
			const assets = { fetch: () => Promise.resolve(new Response('asset')) }
			const env = { FABRIKA_OPERATIONS_DSN: DSN, ASSETS: assets }
			createContractWorker(() => Promise.resolve({ default: notesApp(new Map()) }), options)
			const failing: Promise<unknown>[] = []
			for (let attempt = 0; attempt < 2; attempt++) {
				const state: ApplicationState = {
					storage: bunSqliteStorage(),
					blockConcurrencyWhile: (callback) => callback(),
					waitUntil: (promise) => void failing.push(promise),
				}
				const object = new FabrikaApplication(state, { ...frameworkEnvFor(notesApp(new Map())), FABRIKA_PROXY_SECRET: PROXY_SECRET, ...env })
				await expect(object.fetch(forwarded('/healthz'))).rejects.toThrow('the IAM binding is missing')
			}
			await Promise.all(failing)
			expect(envelopes.map(tagsOf)).toEqual([{ crash: 'boot_failed' }])
			expect(source.listens()).toBe(0)

			const state: ApplicationState = { storage: bunSqliteStorage(), blockConcurrencyWhile: (callback) => callback(), waitUntil: () => {} }
			const object = new FabrikaApplication(state, {
				...frameworkEnvFor(notesApp(new Map())),
				FABRIKA_PROXY_SECRET: PROXY_SECRET,
				...env,
				IAM: keySource,
			})
			expect((await object.fetch(forwarded('/healthz'))).status).toBe(200)
			const log = spyOn(console, 'error').mockImplementation(() => {})
			try {
				source.fire('unhandled_rejection', new RangeError('late'))
				await Bun.sleep(0)
			} finally {
				log.mockRestore()
			}
			expect(envelopes).toHaveLength(2)
			expect(tagsOf(envelopes[1])).toEqual({ crash: 'unhandled_rejection' })
		})
	})

	test('a failed boot is tried again on a later event, after a backoff that doubles, and reported once', async () => {
		await keepingProcessEnvironment(async () => {
			const { envelopes, fetch } = capturingFetch()
			const app = notesApp(new Map())
			let loads = 0
			createContractWorker(() => {
				loads++
				return loads <= 2 ? Promise.reject(new Error(`transient ${loads}`)) : Promise.resolve({ default: app })
			}, { rejections: fakeEvents().events, operationsFetch: fetch })
			const pending: Promise<unknown>[] = []
			const state: ApplicationState = {
				storage: bunSqliteStorage(),
				blockConcurrencyWhile: (callback) => callback(),
				waitUntil: (promise) => void pending.push(promise),
			}
			const start = Date.UTC(2026, 9, 22, 3, 0, 0)
			setSystemTime(new Date(start))
			try {
				const object = new FabrikaApplication(state, {
					...frameworkEnvFor(app),
					FABRIKA_PROXY_SECRET: PROXY_SECRET,
					FABRIKA_OPERATIONS_DSN: DSN,
					IAM: keySource,
					ASSETS: { fetch: () => Promise.resolve(new Response('asset')) },
				})
				await expect(object.fetch(forwarded('/healthz'))).rejects.toThrow('transient 1')
				setSystemTime(new Date(start + 999))
				await expect(object.fetch(forwarded('/healthz'))).rejects.toThrow('transient 1')
				expect(loads).toBe(1)
				setSystemTime(new Date(start + 1000))
				await expect(object.fetch(forwarded('/healthz'))).rejects.toThrow('transient 2')
				setSystemTime(new Date(start + 2999))
				await expect(object.fetch(forwarded('/healthz'))).rejects.toThrow('transient 2')
				expect(loads).toBe(2)
				setSystemTime(new Date(start + 3000))
				expect((await object.fetch(forwarded('/healthz'))).status).toBe(200)
				expect(loads).toBe(3)
			} finally {
				setSystemTime()
			}
			await Promise.all(pending)
			expect(envelopes.map(tagsOf)).toEqual([{ crash: 'boot_failed' }])
		})
	})
})
