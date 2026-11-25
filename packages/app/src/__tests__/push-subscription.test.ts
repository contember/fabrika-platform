// Web Push subscriptions (ADR-0088 §7, §10): a contract that declares notifications gets the subscription row beside the
// worker's, with its own bucket per caller; through the production proxy decision and the dispatcher, the row binds a
// subscription to the caller's token, never rebinds it to another person, accepts a replacement only of the caller's
// own endpoint, refuses an endpoint outside the push services and a key other than the environment's, and refuses a
// terminal. On SQLite, the Durable Object's storage; nothing here sends a push.

import { compileContract, parseContractArtifact } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { TEST_PUSH_KEY, testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isPushServiceEndpoint } from '../implement/push-subscription'
import { pushContract as contract, pushDatabase, pushTables as tables } from './fixtures/push-app'

const SUBSCRIPTION_ROW = {
	id: '__fabrika.push.subscription',
	source: { kind: 'push', name: 'subscription' },
	kind: 'mutation',
	method: 'POST',
	path: '/__fabrika/push/subscription',
	callers: ['human'],
	requirement: { kind: 'member' },
	admission: { contentTypes: ['application/json'], maxBytes: 4096 },
	input: null,
	output: null,
} as const

const RULES = { rate: { perClient: null, perCaller: 30, perEndpoint: null, bytesPerHour: null }, challenge: null, timeoutMs: 10_000 }

describe('the contract build and the artifact parser', () => {
	const artifact = compileContract(contract, tables)
	const json = JSON.parse(JSON.stringify(artifact))

	test('notifications add the subscription row beside the worker row, with its own rules', () => {
		expect(artifact.endpoints.find((row) => row.id === SUBSCRIPTION_ROW.id)).toEqual(SUBSCRIPTION_ROW)
		expect(artifact.endpoints.filter((row) => row.source.kind === 'push').map((row) => row.id).sort()).toEqual([
			'__fabrika.push.subscription',
			'__fabrika.push.worker',
		])
		expect(artifact.procedures?.[SUBSCRIPTION_ROW.id]).toEqual(RULES)
		expect(parseContractArtifact(json)).toEqual(artifact)
	})

	const swapped = (fields: Record<string, unknown>) =>
		json.endpoints.map((row: { readonly id: string }) => (row.id === SUBSCRIPTION_ROW.id ? { ...row, ...fields } : row))
	const withoutRow = json.endpoints.filter((row: { readonly id: string }) => row.id !== SUBSCRIPTION_ROW.id)
	const { [SUBSCRIPTION_ROW.id]: _rules, ...otherRules } = json.procedures

	test.each<[string, Record<string, unknown>]>([
		['notifications without the subscription row', { ...json, endpoints: withoutRow }],
		['a subscription row another caller may call', { ...json, endpoints: swapped({ callers: ['human', 'machine'] }) }],
		['a subscription row with a larger body', { ...json, endpoints: swapped({ admission: { contentTypes: ['application/json'], maxBytes: 65536 } }) }],
		['a subscription row that is a query', { ...json, endpoints: swapped({ kind: 'query' }) }],
		['the subscription row without its rules', { ...json, procedures: otherRules }],
		['the subscription row with a wider bucket', {
			...json,
			procedures: { ...json.procedures, [SUBSCRIPTION_ROW.id]: { ...RULES, rate: { ...RULES.rate, perCaller: 600 } } },
		}],
	])('refuses %s', (_name, value) => {
		expect(() => parseContractArtifact(value)).toThrow()
	})
})

describe('the push services an endpoint may name', () => {
	test.each([
		'https://fcm.googleapis.com/fcm/send/abc',
		'https://updates.push.services.mozilla.com/wpush/v2/abc',
		'https://web.push.apple.com/QGx',
		'https://db5p.notify.windows.com/w/?token=abc',
	])('admits %s', (endpoint) => {
		expect(isPushServiceEndpoint(endpoint)).toBe(true)
	})

	test.each([
		'http://fcm.googleapis.com/fcm/send/abc',
		'https://fcm.googleapis.com:8443/fcm/send/abc',
		'https://user:secret@fcm.googleapis.com/fcm/send/abc',
		'https://fcm.googleapis.com.attacker.test/x',
		'https://notify.windows.com/w',
		'https://a.b.notify.windows.com/w',
		'https://evil-notify.windows.com/w',
		'https://FCM.googleapis.com/fcm/send/abc',
		'https://fcm.googleapis.com/fcm/send/abc#x',
		'https://169.254.169.254/latest',
		'not a url',
	])('refuses %s', (endpoint) => {
		expect(isPushServiceEndpoint(endpoint)).toBe(false)
	})
})

const P256 = (seed: string) => `B${seed.repeat(86).slice(0, 86)}`
const AUTH = 'A'.repeat(22)
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`
const subscription = (name: string) => ({ endpoint: endpoint(name), expirationTime: null, keys: { p256dh: P256('p'), auth: AUTH } })
const record = (name: string, extra: Record<string, unknown> = {}) => ({
	op: 'record',
	subscription: subscription(name),
	key: TEST_PUSH_KEY,
	...extra,
})

type Kit = ReturnType<typeof testKit>
type TestCaller = Parameters<Kit['browser']>[0]

async function post(kit: Kit, caller: TestCaller, body: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
	const response = await kit.browser(caller)('/__fabrika/push/subscription', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
	// The proxy's own refusals are plain text; the row answers JSON.
	const text = await response.text()
	return { status: response.status, body: response.headers.get('Content-Type')?.startsWith('application/json') === true ? JSON.parse(text) : text }
}

const refusal = (status: number, type: string) => ({ status, body: { error: expect.objectContaining({ type }) } })
const whose = (status: string, name: string) => ({ status: 200, body: { status, endpoint: endpoint(name) } })

describe('the subscription row through the proxy and the dispatcher', () => {
	let fresh: Awaited<ReturnType<typeof pushDatabase>>
	let kit: Kit

	beforeEach(async () => {
		fresh = await pushDatabase('push-subscription.test.ts')
		kit = testKit(serve(contract, { database: scoped(tables) }), { database: fresh.database })
	})

	afterEach(async () => {
		await kit.drain()
		await fresh.close()
	})

	const alice = () => kit.testCaller([{ role: 'editor' }], { id: 'alice' })
	const bob = () => kit.testCaller([{ role: 'editor' }], { id: 'bob' })

	test("a subscription is bound to the caller, and another person sees it as someone else's and cannot take it", async () => {
		expect(await post(kit, alice(), { op: 'status', endpoint: endpoint('e1') })).toEqual(whose('unknown', 'e1'))
		expect(await post(kit, alice(), record('e1'))).toEqual(whose('mine', 'e1'))
		expect(await post(kit, alice(), { op: 'status', endpoint: endpoint('e1') })).toEqual(whose('mine', 'e1'))
		expect(await post(kit, bob(), { op: 'status', endpoint: endpoint('e1') })).toEqual(whose('other', 'e1'))
		expect(await post(kit, bob(), record('e1'))).toMatchObject(refusal(409, 'push_subscription_taken'))
		expect(await post(kit, alice(), { op: 'status', endpoint: endpoint('e1') })).toEqual(whose('mine', 'e1'))
	})

	test("a replacement of the caller's own endpoint moves the binding; of another person's it is refused and changes nothing", async () => {
		await post(kit, alice(), record('old'))
		expect(await post(kit, alice(), record('new', { replace: endpoint('old') }))).toEqual(whose('mine', 'new'))
		expect(await post(kit, alice(), { op: 'status', endpoint: endpoint('old') })).toEqual(whose('unknown', 'old'))
		expect(await post(kit, bob(), record('bob', { replace: endpoint('new') }))).toMatchObject(refusal(409, 'push_replacement_refused'))
		expect(await post(kit, bob(), { op: 'status', endpoint: endpoint('bob') })).toEqual(whose('unknown', 'bob'))
		expect(await post(kit, alice(), { op: 'status', endpoint: endpoint('new') })).toEqual(whose('mine', 'new'))
	})

	test("a replacement onto another person's endpoint is refused, and the caller's old subscription stays", async () => {
		await post(kit, alice(), record('old'))
		await post(kit, bob(), record('bob'))
		expect(await post(kit, alice(), record('bob', { replace: endpoint('old') }))).toMatchObject(refusal(409, 'push_subscription_taken'))
		expect(await post(kit, alice(), { op: 'status', endpoint: endpoint('old') })).toEqual(whose('mine', 'old'))
		expect(await post(kit, bob(), { op: 'status', endpoint: endpoint('bob') })).toEqual(whose('mine', 'bob'))
	})

	test("a removal reaches only the caller's own subscription", async () => {
		await post(kit, alice(), record('e1'))
		expect(await post(kit, bob(), { op: 'remove', endpoint: endpoint('e1') })).toEqual(whose('other', 'e1'))
		expect(await post(kit, alice(), { op: 'remove', endpoint: endpoint('e1') })).toEqual(whose('unknown', 'e1'))
	})

	test('an endpoint outside the push services, another key, a principal or an unknown field in the body are refused', async () => {
		expect(await post(kit, alice(), { ...record('e1'), subscription: { ...subscription('e1'), endpoint: 'https://attacker.test/hook' } }))
			.toMatchObject(refusal(400, 'push_service'))
		expect(await post(kit, alice(), record('e1', { key: P256('k') }))).toMatchObject(refusal(409, 'push_key'))
		expect(await post(kit, alice(), record('e1', { principal: 'bob' }))).toMatchObject(refusal(400, 'push_subscription'))
		expect(await post(kit, alice(), { ...record('e1'), subscription: { ...subscription('e1'), keys: { p256dh: 'short', auth: AUTH } } }))
			.toMatchObject(refusal(400, 'push_subscription'))
		expect(await post(kit, alice(), '{not json')).toMatchObject(refusal(400, 'push_subscription'))
		expect(await post(kit, alice(), { op: 'status', endpoint: endpoint('e1') })).toEqual(whose('unknown', 'e1'))
	})

	test('a person on a terminal records nothing, and asks nothing', async () => {
		// The ceiling keeps the person's own permissions, so the proxy admits the row and the dispatcher refuses the terminal.
		const terminal = { id: 'terminal-1', label: 'Entrance', grants: [], ceiling: ['notes.*'] }
		const onTerminal = kit.testCaller([{ role: 'editor' }], { id: 'alice', terminal })
		expect(await post(kit, onTerminal, record('e1'))).toMatchObject(refusal(403, 'forbidden'))
		expect(await post(kit, onTerminal, { op: 'status', endpoint: endpoint('e1') })).toMatchObject(refusal(403, 'forbidden'))
		expect(await post(kit, alice(), { op: 'status', endpoint: endpoint('e1') })).toEqual(whose('unknown', 'e1'))
	})

	test('a person without a permission, and a request without a session, never reach the table', async () => {
		expect(await post(kit, kit.testCaller([]), record('e1'))).toEqual({ status: 403, body: 'forbidden' })
		const anonymous = await kit.fetch('/__fabrika/push/subscription', {
			method: 'POST',
			// A page's fetch: without Sec-Fetch-Mode the proxy takes it for a navigation and answers its sign-in redirect.
			headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'same-origin' },
			body: JSON.stringify(record('e1')),
		})
		expect(anonymous.status).toBe(401)
	})

	test('a caller has 30 requests a minute; another caller has their own', async () => {
		for (let n = 0; n < 30; n++) {
			expect((await post(kit, alice(), { op: 'status', endpoint: endpoint('e1') })).status).toBe(200)
		}
		expect(await post(kit, alice(), { op: 'status', endpoint: endpoint('e1') })).toMatchObject(refusal(429, 'rate_limited'))
		expect((await post(kit, bob(), { op: 'status', endpoint: endpoint('e1') })).status).toBe(200)
	})

	test('an environment without a VAPID key records nothing (503), and still answers whose an endpoint is', async () => {
		await kit.drain()
		const keyless = testKit(serve(contract, { database: scoped(tables) }), { database: fresh.database, pushKey: null })
		const person = keyless.testCaller([{ role: 'editor' }], { id: 'alice' })
		try {
			expect((await post(keyless, person, record('e1'))).status).toBe(503)
			expect(await post(keyless, person, { op: 'status', endpoint: endpoint('e1') })).toEqual(whose('unknown', 'e1'))
		} finally {
			await keyless.drain()
		}
	})
})
