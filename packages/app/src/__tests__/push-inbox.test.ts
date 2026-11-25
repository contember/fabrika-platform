// The Web Push inbox (ADR-0088 §4–§7): the worker names its subscription and gets the caller's notifications written
// after its cursor, only those the caller may read now, through the production proxy decision and the dispatcher. The
// cursor moves past every row read; another person's subscription is deleted and answered as not the caller's. On
// SQLite, the Durable Object's storage. Nothing here sends a push, and nothing writes a notification but the test.

import { compileContract, parseContractArtifact } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { TEST_PUSH_KEY, testKit } from '@fabrika/app/testing'
import { scoped } from '@fabrika/db'
import { frameworkTablesOf, type NotificationAbout } from '@fabrika/db/framework'
import { uuidv7 } from '@fabrika/platform'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runFixedStatement, sessionOf } from '../../../db/src/database'
import { pushContract as contract, pushDatabase, pushTables as tables } from './fixtures/push-app'

const INBOX_ROW = {
	id: '__fabrika.push.inbox',
	source: { kind: 'push', name: 'inbox' },
	kind: 'mutation',
	method: 'POST',
	path: '/__fabrika/push/inbox',
	callers: ['human'],
	requirement: { kind: 'member' },
	admission: { contentTypes: ['application/json'], maxBytes: 2048 },
	input: null,
	output: null,
} as const

describe('the contract build and the artifact parser', () => {
	const artifact = compileContract(contract, tables)
	const json = JSON.parse(JSON.stringify(artifact))

	test('notifications add the inbox row with a bucket of its own', () => {
		expect(artifact.endpoints.find((row) => row.id === INBOX_ROW.id)).toEqual(INBOX_ROW)
		expect(artifact.procedures?.[INBOX_ROW.id]).toEqual({
			rate: { perClient: null, perCaller: 60, perEndpoint: null, bytesPerHour: null },
			challenge: null,
			timeoutMs: 10_000,
		})
		expect(parseContractArtifact(json)).toEqual(artifact)
	})

	test.each<[string, Record<string, unknown>]>([
		['notifications without the inbox row', { ...json, endpoints: json.endpoints.filter((row: { readonly id: string }) => row.id !== INBOX_ROW.id) }],
		['an inbox row a machine may call', {
			...json,
			endpoints: json.endpoints.map((row: { readonly id: string }) => (row.id === INBOX_ROW.id ? { ...row, callers: ['human', 'machine'] } : row)),
		}],
		['an inbox row without its bucket', {
			...json,
			procedures: Object.fromEntries(Object.entries(json.procedures).filter(([id]) => id !== INBOX_ROW.id)),
		}],
	])('refuses %s', (_name, value) => {
		expect(() => parseContractArtifact(value)).toThrow()
	})
})

const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`
const P256 = `B${'p'.repeat(86)}`
const record = (name: string) => ({
	op: 'record',
	subscription: { endpoint: endpoint(name), expirationTime: null, keys: { p256dh: P256, auth: 'A'.repeat(22) } },
	key: TEST_PUSH_KEY,
})

type Kit = ReturnType<typeof testKit>
type TestCaller = Parameters<Kit['browser']>[0]

async function post(kit: Kit, caller: TestCaller, path: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
	const response = await kit.browser(caller)(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
	const text = await response.text()
	return { status: response.status, body: response.headers.get('Content-Type')?.startsWith('application/json') === true ? JSON.parse(text) : text }
}

const W1: NotificationAbout = { action: 'notes.read', dimension: 'workspace', value: 'w1' }
const W2: NotificationAbout = { action: 'notes.read', dimension: 'workspace', value: 'w2' }
const APP: NotificationAbout = { action: 'notes.read', dimension: null, value: null }
const UNDECLARED: NotificationAbout = { action: 'orders.read', dimension: null, value: null }
const MISSING_NOTE: NotificationAbout = { action: 'notes.read', dimension: 'note', value: '0190f000-0000-7000-8000-000000000099' }

describe('the inbox through the proxy and the dispatcher', () => {
	let fresh: Awaited<ReturnType<typeof pushDatabase>>
	let layer: ReturnType<typeof scoped>
	let kit: Kit

	beforeEach(async () => {
		fresh = await pushDatabase('push-inbox.test.ts')
		layer = scoped(tables)
		kit = testKit(serve(contract, { database: layer }), { database: fresh.database })
	})

	afterEach(async () => {
		await kit.drain()
		await fresh.close()
	})

	const alice = () => kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w1' } }], { id: 'alice' })
	const bob = () => kit.testCaller([{ role: 'editor', scope: { type: 'workspace', value: 'w1' } }], { id: 'bob' })
	const admin = () => kit.testCaller([{ role: 'editor' }], { id: 'admin' })

	/** Writes a notification for `principal` as `ctx.notify` will, and answers its id. */
	async function notify(principal: string, title: string, about: NotificationAbout): Promise<string> {
		const id = uuidv7()
		const session = sessionOf({ database: fresh.database })
		await frameworkTablesOf(layer).notifications.record(session, {
			id,
			principal,
			title,
			body: `${title} body`,
			path: '/',
			about,
			createdAt: Date.now(),
		})
		return id
	}

	const inbox = (caller: TestCaller, name: string) => post(kit, caller, '/__fabrika/push/inbox', { endpoint: endpoint(name) })
	const titles = (answer: { readonly body: unknown }) => {
		const body = answer.body
		return typeof body === 'object' && body !== null && 'notifications' in body && Array.isArray(body.notifications)
			? body.notifications.map((row: { readonly title: string }) => row.title)
			: null
	}

	test('answers only what the caller may read now, and the cursor moves past every row it read', async () => {
		await post(kit, alice(), '/__fabrika/push/subscription', record('alice'))
		await notify('alice', 'in w1', W1)
		await notify('alice', 'in w2', W2)
		await notify('alice', 'app-wide', APP)
		await notify('alice', 'undeclared action', UNDECLARED)
		await notify('alice', 'a note that is gone', MISSING_NOTE)
		await notify('bob', "bob's", W1)
		const first = await inbox(alice(), 'alice')
		expect(first).toMatchObject({ status: 200, body: { mine: true, more: 0 } })
		expect(titles(first)).toEqual(['in w1'])
		// Every row was read, so nothing comes again; a new one does, alone.
		expect(titles(await inbox(alice(), 'alice'))).toEqual([])
		await notify('alice', 'later', W1)
		expect(titles(await inbox(alice(), 'alice'))).toEqual(['later'])
	})

	test('an application-wide notification reaches a holder of the action as a global grant', async () => {
		await post(kit, admin(), '/__fabrika/push/subscription', record('admin'))
		await notify('admin', 'app-wide', APP)
		await notify('admin', 'in w2', W2)
		expect(titles(await inbox(admin(), 'admin'))).toEqual(['app-wide', 'in w2'])
	})

	test('one read answers at most twenty rows and counts the rest', async () => {
		await post(kit, alice(), '/__fabrika/push/subscription', record('alice'))
		for (let n = 0; n < 25; n++) await notify('alice', `n${n}`, W1)
		const first = await inbox(alice(), 'alice')
		expect(first).toMatchObject({ status: 200, body: { mine: true, more: 5 } })
		expect(titles(first)?.length).toBe(20)
		const second = await inbox(alice(), 'alice')
		expect(second).toMatchObject({ body: { mine: true, more: 0 } })
		expect(titles(second)).toEqual(['n20', 'n21', 'n22', 'n23', 'n24'])
	})

	test("another person's subscription is answered as not the caller's and deleted, and its text never shown", async () => {
		await post(kit, alice(), '/__fabrika/push/subscription', record('shared'))
		await notify('alice', "alice's", W1)
		expect(await inbox(bob(), 'shared')).toEqual({ status: 200, body: { mine: false, notifications: [], more: 0 } })
		expect(await post(kit, alice(), '/__fabrika/push/subscription', { op: 'status', endpoint: endpoint('shared') }))
			.toEqual({ status: 200, body: { status: 'unknown', endpoint: endpoint('shared') } })
	})

	test("an endpoint nobody recorded is not the caller's; a body without one is refused", async () => {
		expect(await inbox(alice(), 'nobody')).toEqual({ status: 200, body: { mine: false, notifications: [], more: 0 } })
		expect(await post(kit, alice(), '/__fabrika/push/inbox', { endpoint: endpoint('x'), principal: 'bob' }))
			.toMatchObject({ status: 400, body: { error: { type: 'push_inbox' } } })
	})

	test("a terminal session is refused and shows nothing, though the browser's subscription is the person's", async () => {
		await post(kit, admin(), '/__fabrika/push/subscription', record('kiosk'))
		await notify('admin', 'secret title', APP)
		// The ceiling keeps the person's permissions, so the proxy admits the row and the dispatcher refuses the terminal.
		const terminal = { id: 'terminal-1', label: 'Entrance', grants: [], ceiling: ['notes.*'] }
		const onTerminal = kit.testCaller([{ role: 'editor' }], { id: 'admin', terminal })
		expect(await inbox(onTerminal, 'kiosk')).toMatchObject({ status: 403, body: { error: { type: 'forbidden' } } })
		// Negative control: the same person's own session reads it.
		expect(titles(await inbox(admin(), 'kiosk'))).toEqual(['secret title'])
	})

	test('a new subscription reads only what is written after it', async () => {
		await notify('alice', 'before subscribing', W1)
		await post(kit, alice(), '/__fabrika/push/subscription', record('alice'))
		await notify('alice', 'after subscribing', W1)
		expect(titles(await inbox(alice(), 'alice'))).toEqual(['after subscribing'])
	})

	test("a row about an object is read through a grant on the object's container, and hidden in another one", async () => {
		const session = sessionOf({ database: fresh.database })
		const note = (id: string, workspace: string) =>
			runFixedStatement(session, 'insert into notes (id, workspace_id, title, created_by, version) values (?1, ?2, ?3, ?4, 1)', [
				id,
				workspace,
				'n',
				'x',
			])
		const inW1 = uuidv7()
		const inW2 = uuidv7()
		await note(inW1, 'w1')
		await note(inW2, 'w2')
		await post(kit, alice(), '/__fabrika/push/subscription', record('alice'))
		await notify('alice', 'note in w1', { action: 'notes.read', dimension: 'note', value: inW1 })
		await notify('alice', 'note in w2', { action: 'notes.read', dimension: 'note', value: inW2 })
		expect(titles(await inbox(alice(), 'alice'))).toEqual(['note in w1'])
	})

	test('a person without a permission never reaches it', async () => {
		expect(await post(kit, kit.testCaller([]), '/__fabrika/push/inbox', { endpoint: endpoint('x') })).toEqual({ status: 403, body: 'forbidden' })
	})
})
