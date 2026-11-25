// Web Push, the first slice (ADR-0088): a contract that declares notifications gets the service worker's row under the
// reserved push prefix, credentialed like a member SPA, and the framework serves the fixed worker script there behind
// the production proxy decision.

import { compileContract, defineApp, defineContract, defineVocabulary, parseContractArtifact } from '@fabrika/app/contract'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
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

	test('the staged kit carries the declaration from defineVocabulary through app.contract', () => {
		const kit = defineApp(defineVocabulary({ ...vocabulary, notifications: true }))
		const contract = kit.contract((c) => ({ web: c.spa('/', { dir: 'dist/web', access: { member: true } }), health: c.health('/healthz') }))
		const artifact = compileContract(contract, {})
		expect(artifact.notifications).toBe(true)
		expect(artifact.endpoints.find((row) => row.source.kind === 'push')).toEqual(WORKER_ROW)
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
		['a worker row on another path', { ...artifact, endpoints: swapWorker(artifact, { path: '/__fabrika/push/other.js' }) }],
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

	test('tags a row of the inbox apart from the fixed notice and the summary', () => {
		expect(PUSH_WORKER_SCRIPT).toContain("tag: 'fabrika-n-' + notification.id")
	})

	test('parses as a script', () => {
		const transpiler = new Bun.Transpiler({ loader: 'js' })
		expect(() => transpiler.transformSync(PUSH_WORKER_SCRIPT)).not.toThrow()
	})
})

interface Shown {
	readonly title: string
	readonly body: string
	readonly tag: string
	readonly path: unknown
}

interface WorkerOptions {
	readonly unsubscribeFails?: boolean
	readonly subscribed?: boolean
}

/** The worker script run in a context of its own, against a fake service worker global with no storage. */
function runWorker(inbox: () => Promise<Response>, options: WorkerOptions = {}) {
	const shown: Shown[] = []
	const opened: string[] = []
	const counts = { closed: 0, unsubscribed: 0 }
	const listeners = new Map<string, (event: unknown) => void>()
	const subscription = {
		endpoint: 'https://fcm.googleapis.com/fcm/send/one',
		unsubscribe: () => {
			counts.unsubscribed += 1
			return options.unsubscribeFails === true ? Promise.reject(new Error('refused')) : Promise.resolve(true)
		},
		toJSON: () => ({}),
	}
	const self = {
		location: { origin: 'https://app.test', hostname: 'app.test' },
		addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
		skipWaiting: () => undefined,
		registration: {
			pushManager: { getSubscription: () => Promise.resolve(options.subscribed === false ? null : subscription) },
			showNotification: (title: string, notification: { readonly body: string; readonly tag: string; readonly data: { readonly path: unknown } }) => {
				shown.push({ title, body: notification.body, tag: notification.tag, path: notification.data.path })
				return Promise.resolve()
			},
			getNotifications: () => Promise.resolve([{ close: () => (counts.closed += 1) }]),
		},
		clients: {
			matchAll: () => Promise.resolve([]),
			openWindow: (url: string) => {
				opened.push(url)
				return Promise.resolve(null)
			},
		},
	}
	const indexedDB = {
		open: () => {
			throw new Error('no storage in this context')
		},
	}
	runInNewContext(PUSH_WORKER_SCRIPT, { self, fetch: () => inbox(), indexedDB, URL })
	async function dispatch(type: string, event: Record<string, unknown>): Promise<void> {
		let pending: unknown
		listeners.get(type)?.({ ...event, waitUntil: (promise: unknown) => (pending = promise) })
		await pending
	}
	return { shown, opened, counts, dispatch }
}

function answering(status: number, value: unknown): () => Promise<Response> {
	return () => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }))
}

const NOTICE: Shown = { title: 'app.test', body: 'Open to see what is new', tag: PUSH_NOTICE_TAG, path: '/' }

function rows(count: number, path: string): { id: string; title: string; body: string; path: string }[] {
	return Array.from({ length: count }, (_, index) => ({ id: 'n' + String(index + 1), title: 'Order ' + String(index + 1), body: 'New order', path }))
}

describe('the worker script, run', () => {
	test('a 401 closes what it showed and shows the fixed notice, keeping the subscription', async () => {
		const worker = runWorker(answering(401, { error: { type: 'unauthorized' } }))
		await worker.dispatch('push', {})
		expect(worker.shown).toEqual([NOTICE])
		expect(worker.counts).toEqual({ closed: 1, unsubscribed: 0 })
	})

	test('a 403 closes, unsubscribes and shows the notice, also when unsubscribing fails', async () => {
		for (const unsubscribeFails of [false, true]) {
			const worker = runWorker(answering(403, { error: { type: 'forbidden' } }), { unsubscribeFails })
			await worker.dispatch('push', {})
			expect(worker.shown).toEqual([NOTICE])
			expect(worker.counts).toEqual({ closed: 1, unsubscribed: 1 })
		}
	})

	test("a subscription that is another person's is unsubscribed, with the notice", async () => {
		const worker = runWorker(answering(200, { mine: false, notifications: [], more: 0 }), { unsubscribeFails: true })
		await worker.dispatch('push', {})
		expect(worker.shown).toEqual([NOTICE])
		expect(worker.counts.unsubscribed).toBe(1)
	})

	test('five rows are shown, the rest and the answer’s more become one summary', async () => {
		const worker = runWorker(answering(200, { mine: true, notifications: rows(7, '/orders/1'), more: 2 }))
		await worker.dispatch('push', {})
		expect(worker.shown.map((shown) => shown.tag)).toEqual([
			'fabrika-n-n1',
			'fabrika-n-n2',
			'fabrika-n-n3',
			'fabrika-n-n4',
			'fabrika-n-n5',
			'fabrika-more',
		])
		expect(worker.shown[5]).toEqual({ title: 'app.test', body: '+4', tag: 'fabrika-more', path: '/' })
	})

	test('a row whose path holds a control character or names another origin is never shown', async () => {
		for (const path of ['/\t/other.example', '/\n/other.example', '//other.example', '/\\other.example', 'https://other.example/']) {
			const worker = runWorker(answering(200, { mine: true, notifications: rows(1, path), more: 0 }))
			await worker.dispatch('push', {})
			expect(worker.shown).toEqual([NOTICE])
		}
	})

	test('no subscription, an unreachable inbox and an answer that is no JSON each still show the notice', async () => {
		const cases = [
			runWorker(answering(200, { mine: true, notifications: rows(1, '/a'), more: 0 }), { subscribed: false }),
			runWorker(() => Promise.reject(new Error('offline'))),
			runWorker(() => Promise.resolve(new Response('not json', { status: 200 }))),
		]
		for (const worker of cases) {
			await worker.dispatch('push', {})
			expect(worker.shown).toEqual([NOTICE])
		}
	})

	test('a click opens a path of this origin, and the start of the application for anything else', async () => {
		const worker = runWorker(answering(200, {}))
		for (const path of ['/orders/1', '/\t/other.example', '//other.example', undefined]) {
			await worker.dispatch('notificationclick', { notification: { close: () => undefined, data: { path } } })
		}
		expect(worker.opened).toEqual(['https://app.test/orders/1', 'https://app.test/', 'https://app.test/', 'https://app.test/'])
	})
})
