// Web Push, the first slice (ADR-0088): a contract that declares notifications gets the service worker's row under the
// reserved push prefix, credentialed like a member SPA, and the framework serves the fixed worker script there behind
// the production proxy decision.

import { compileContract, defineContract, parseContractArtifact } from '@fabrika/app/contract'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { implement } from '../implement/implement'
import { PUSH_NOTICE_TAG, PUSH_WORKER_SCRIPT } from '../implement/push-worker'

const vocabulary = {
	app: 'orders',
	dimensions: { workspace: {} },
	actions: { 'orders.read': 'Read orders' },
	roles: { clerk: { grants: ['orders.read'], member: { scope: 'workspace', assignableBy: ['clerk'] } } },
} as const

const notifying = defineContract({ ...vocabulary, notifications: true }, (c) => ({
	web: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	health: c.health('/healthz'),
}))
const silent = defineContract(vocabulary, (c) => ({
	web: c.spa('/', { dir: 'dist/web', access: { member: true } }),
	health: c.health('/healthz'),
}))

const WORKER_ROW = {
	id: '__fabrika.push.worker',
	source: { kind: 'push', name: 'worker' },
	kind: 'query',
	method: 'GET',
	path: '/__fabrika/push/worker.js',
	callers: ['human'],
	requirement: { kind: 'member' },
	admission: null,
	input: null,
	output: null,
} as const

describe('the contract build', () => {
	test('notifications: true adds the service worker row, credentialed, and reserves the push prefix', () => {
		const artifact = compileContract(notifying, {})
		expect(artifact.notifications).toBe(true)
		expect(artifact.endpoints.find((row) => row.source.kind === 'push')).toEqual(WORKER_ROW)
		expect(artifact.reservedPrefixes).toContain('/__fabrika/push')
	})

	test('without the declaration there is no push row, no field and no reserved prefix', () => {
		const artifact = compileContract(silent, {})
		expect(artifact.notifications).toBeUndefined()
		expect(artifact.endpoints.filter((row) => row.source.kind === 'push')).toEqual([])
		expect(artifact.reservedPrefixes).not.toContain('/__fabrika/push')
	})
})

describe('the artifact parser', () => {
	const artifact = JSON.parse(JSON.stringify(compileContract(notifying, {})))
	const without = JSON.parse(JSON.stringify(compileContract(silent, {})))

	test('reads the notifying artifact back unchanged', () => {
		expect(parseContractArtifact(artifact)).toEqual(compileContract(notifying, {}))
	})

	test.each<[string, Record<string, unknown>]>([
		['notifications without the worker row', { ...artifact, endpoints: without.endpoints }],
		['the worker row without notifications', { ...artifact, notifications: undefined }],
		['the worker row without the reserved prefix', { ...artifact, reservedPrefixes: without.reservedPrefixes }],
		['a worker row another caller may call', { ...artifact, endpoints: swapWorker(artifact, { callers: ['human', 'machine'] }) }],
		['a worker row at another path', { ...artifact, endpoints: swapWorker(artifact, { path: '/__fabrika/push/other.js' }) }],
		['a worker row with an action requirement', {
			...artifact,
			endpoints: swapWorker(artifact, { requirement: { kind: 'action', action: 'orders.read', access: { form: 'app' } } }),
		}],
		['notifications: false', { ...artifact, notifications: false }],
	])('refuses %s', (_name, value) => {
		expect(() => parseContractArtifact(value)).toThrow()
	})
})

function swapWorker(artifact: { readonly endpoints: readonly { readonly id: string }[] }, fields: Record<string, unknown>): unknown[] {
	return artifact.endpoints.map((row) => (row.id === WORKER_ROW.id ? { ...row, ...fields } : row))
}

describe('the production proxy and the dispatcher serve the worker under the row', () => {
	const app = implement(notifying, { database: null, deps: () => ({}), handlers: () => ({}) })
	const clerk = [{ role: 'clerk', scope: { type: 'workspace', value: 'w1' } }] as const

	test('a member gets the fixed script as JavaScript, no-store, from the framework and not the asset server', async () => {
		const served: string[] = []
		const kit = testKit(app, {
			assets: {
				serve: (_mount, request) => {
					served.push(new URL(request.url).pathname)
					return Promise.resolve(new Response('page', { headers: { 'Content-Type': 'text/html' } }))
				},
			},
		})
		const response = await kit.browser(kit.testCaller(clerk))('/__fabrika/push/worker.js')
		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(await response.text()).toBe(PUSH_WORKER_SCRIPT)
		expect(served).toEqual([])
	})

	test('without a session it is refused like a member page, and a person without a permission gets nothing', async () => {
		const kit = testKit(app)
		const fetched = await kit.fetch('/__fabrika/push/worker.js', { headers: { 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Dest': 'serviceworker' } })
		expect(fetched.status).toBe(401)
		const stranger = await kit.browser(kit.testCaller([]))('/__fabrika/push/worker.js')
		expect(stranger.status).toBe(403)
	})

	test('no other path under the reserved prefix reaches the root SPA', async () => {
		const kit = testKit(app, { assets: { serve: () => Promise.resolve(new Response('page', { headers: { 'Content-Type': 'text/html' } })) } })
		const other = await kit.browser(kit.testCaller(clerk))('/__fabrika/push/inbox')
		expect(other.status).toBe(403)
		expect(await other.text()).not.toBe('page')
	})

	test('a contract without the declaration serves its root SPA there, as before', async () => {
		const plain = implement(silent, { database: null, deps: () => ({}), handlers: () => ({}) })
		const kit = testKit(plain, { assets: { serve: () => Promise.resolve(new Response('page', { headers: { 'Content-Type': 'text/plain' } })) } })
		const response = await kit.browser(kit.testCaller(clerk))('/__fabrika/push/worker.js')
		expect(await response.text()).toBe('page')
	})
})

describe('the worker script', () => {
	test('stands between no request and the network: no fetch handler, no cache, no payload read', () => {
		expect(PUSH_WORKER_SCRIPT).not.toContain("addEventListener('fetch'")
		expect(PUSH_WORKER_SCRIPT).not.toContain('caches')
		expect(PUSH_WORKER_SCRIPT).not.toContain('event.data')
		expect(PUSH_WORKER_SCRIPT).not.toContain('eval(')
	})

	test('handles push, a click and a changed subscription, and tags the fixed notice once', () => {
		for (const event of ["addEventListener('push'", "addEventListener('notificationclick'", "addEventListener('pushsubscriptionchange'"]) {
			expect(PUSH_WORKER_SCRIPT).toContain(event)
		}
		expect(PUSH_WORKER_SCRIPT).toContain("const NOTICE_TAG = '" + PUSH_NOTICE_TAG + "'")
		expect(PUSH_WORKER_SCRIPT).toContain("const INBOX = '/__fabrika/push/inbox'")
	})

	test('parses as a script', () => {
		const transpiler = new Bun.Transpiler({ loader: 'js' })
		expect(() => transpiler.transformSync(PUSH_WORKER_SCRIPT)).not.toThrow()
	})
})
