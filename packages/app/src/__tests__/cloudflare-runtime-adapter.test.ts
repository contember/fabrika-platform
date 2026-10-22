// What the environment object boots with besides its database: the IAM binding (keys and membership), the SPA's
// assets and the crash reports of its isolate. Each object is constructed directly, as workerd constructs it.

import { defineContract } from '@fabrika/app/contract'
import { PROXY_SECRET_HEADER } from '@fabrika/auth-core'
import { describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import { type ApplicationState, type ContractWorkerOptions, createContractWorker, FabrikaApplication } from '../cloudflare'
import type { CrashEvents, ProcessCrashKind } from '../implement/crashes'
import type { ContractImplementation } from '../implement/implement'
import { implement } from '../implement/implement'
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
} from './fixtures/implement/harness'

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
})
