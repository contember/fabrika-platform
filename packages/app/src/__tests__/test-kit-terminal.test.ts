// The test kit's IAM opens identifications at a terminal (ADR-0067) as IAM does when an enrolled terminal's browser
// arrives with no login, and answers the application's `ctx.terminals` under IAM's rules: the application's own
// credential (a public procedure's workload token, or a person's session token), single use, two minutes, and a principal
// that may sign in at a terminal. On the SQLite test database, which a public procedure's buckets need, so it never skips.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import type { IamTerminalRpc } from '@fabrika/auth-core'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { kitIdentifications } from '../testing/terminals'

interface VisitsTable {
	id: string
	terminal_id: string
}

const columns: TypedColumnList<{ visits: VisitsTable }> = {
	visits: { columns: ['id', 'terminal_id'], foreignKeys: [], timestamps: [] },
}

const vocabulary = defineVocabulary({
	app: 'kiosk',
	dimensions: {},
	actions: { 'kiosk.identify': 'Identify at the kiosk', 'attendance.record': 'Record attendance' },
	roles: { clerk: { grants: ['attendance.record'] } },
	terminal: { identify: '/identify' },
})

const tables = defineTables(vocabulary, columns)({
	visits: { scope: { app: 'the visits of the kiosk' }, actions: { read: 'kiosk.identify', insert: 'kiosk.identify' }, insert: ['terminal_id'] },
})

const app = defineApp(vocabulary, tables)
const Id = z.strictObject({ id: z.string() })

// The page's procedure is public, so it asks IAM with its workload token; the desk's run in a person's session.
const page = app.group({}, (r) => ({
	opened: r.mutation({
		input: Id,
		output: z.strictObject({ terminal: z.nullable(z.strictObject({ id: z.string(), label: z.string() })), expiresAt: z.nullable(z.number()) }),
		access: { public: true },
		actions: ['kiosk.identify'],
	}).handle(async ({ input, ctx }) => {
		const open = await ctx.terminals.inspect(input.id)
		return { terminal: open?.terminal ?? null, expiresAt: open?.expiresAt ?? null }
	}),
}))

const desk = app.group({ callers: ['human'] }, (r) => ({
	assert: r.mutation({
		input: z.strictObject({ id: z.string(), principalId: z.string() }),
		output: z.strictObject({ completionUrl: z.nullable(z.string()), refused: z.nullable(z.string()) }),
		access: { action: 'attendance.record', app: true },
	}).handle(async ({ input, ctx }) => {
		const asserted = await ctx.terminals.assert(input.id, input.principalId)
		return asserted.ok ? { completionUrl: asserted.completionUrl, refused: null } : { completionUrl: null, refused: asserted.reason }
	}),
	cancel: r.mutation({ input: Id, output: z.strictObject({}), access: { action: 'attendance.record', app: true } }).handle(async ({ input, ctx }) => {
		await ctx.terminals.cancel(input.id)
		return {}
	}),
}))

const contract = app.contract((c) => ({
	api: c.rpc('/api', { page, desk }),
	identify: c.spa('/identify', { dir: 'dist/identify', access: { public: true } }),
}))
const served = serve(contract, { database: scoped(tables) })

const directory = mkdtempSync(join(tmpdir(), 'fabrika-kit-terminal-'))
mkdirSync(join(directory, 'migrations'))
writeFileSync(
	join(directory, 'migrations', '20261126120000_visits.sql'),
	`CREATE TABLE visits (
	id TEXT PRIMARY KEY,
	terminal_id TEXT NOT NULL
) STRICT;
`,
)
const database = await testDatabase({ migrations: join(directory, 'migrations'), label: 'test-kit-terminal.test.ts' })
const kit = testKit(served, { database: database.database })
const clerk = kit.browser(kit.testCaller([{ role: 'clerk' }]))

afterAll(async () => {
	await kit.drain()
	await database.close()
	rmSync(directory, { recursive: true, force: true })
})

async function post(fetch: typeof clerk, path: string, input: unknown): Promise<unknown> {
	const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
	expect(response.status).toBe(200)
	return await response.json()
}

const notFound = { result: { completionUrl: null, refused: 'not_found' } }

describe("the test kit's IAM opens identifications", () => {
	test('an opened identification is inspected by a public procedure and asserted once, for a person of the kit', async () => {
		const worker = kit.testCaller([], { id: 'worker-1' })
		const opened = kit.openIdentification({ id: 'terminal-9', label: 'Entrance' })
		expect(opened.terminal).toEqual({ id: 'terminal-9', label: 'Entrance' })
		expect(opened.url).toBe(`https://kiosk.test/identify?identification=${opened.id}`)
		expect(await post(kit.browser(), '/api/page.opened', { id: opened.id })).toEqual({
			result: { terminal: { id: 'terminal-9', label: 'Entrance' }, expiresAt: opened.expiresAt },
		})
		expect(kit.identification(opened.id)?.state).toBe('open')

		const completionUrl = `https://iam.test/auth/terminals/complete?identification=${opened.id}`
		expect(await post(clerk, '/api/desk.assert', { id: opened.id, principalId: worker.id })).toEqual({ result: { completionUrl, refused: null } })
		expect(kit.identification(opened.id)).toEqual({ ...opened, state: 'asserted', principalId: 'worker-1', completionUrl })
		// Single use, as IAM consumes it.
		expect(await post(clerk, '/api/desk.assert', { id: opened.id, principalId: worker.id })).toEqual(notFound)
		expect(await post(kit.browser(), '/api/page.opened', { id: opened.id })).toEqual({ result: { terminal: null, expiresAt: null } })
	})

	test('each identification is its own, also on one terminal', async () => {
		const entrance = { id: 'terminal-entrance', label: 'Entrance' }
		const first = kit.openIdentification(entrance)
		const second = kit.openIdentification(entrance)
		expect(first.id).not.toBe(second.id)
		await post(clerk, '/api/desk.cancel', { id: first.id })
		expect(await post(kit.browser(), '/api/page.opened', { id: second.id })).toEqual({ result: { terminal: entrance, expiresAt: second.expiresAt } })
		const unnamed = [kit.openIdentification(), kit.openIdentification()].map((identification) => identification.terminal.id)
		expect(new Set(unnamed).size).toBe(2)
	})

	test('a principal that cannot sign in at a terminal is refused and leaves the identification open', async () => {
		const refused = [
			'nobody',
			kit.testCaller([], { disabled: true }).id,
			kit.testCaller([], { affiliation: 'external' }).id,
			kit.testCaller([], { kind: 'machine' }).id,
			kit.testCaller([], { kind: 'link' }).id,
		]
		const opened = kit.openIdentification()
		for (const principalId of refused) {
			expect(await post(clerk, '/api/desk.assert', { id: opened.id, principalId })).toEqual({
				result: { completionUrl: null, refused: 'invalid_principal' },
			})
		}
		expect(kit.identification(opened.id)?.state).toBe('open')
	})

	test('a cancelled, unknown or expired identification is not found', async () => {
		const person = kit.testCaller([])
		const cancelled = kit.openIdentification()
		await post(clerk, '/api/desk.cancel', { id: cancelled.id })
		expect(kit.identification(cancelled.id)?.state).toBe('cancelled')
		for (const id of [cancelled.id, 'identification_unknown']) {
			expect(await post(clerk, '/api/desk.assert', { id, principalId: person.id })).toEqual(notFound)
		}
		expect(kit.identification('identification_unknown')).toBeUndefined()

		const expiring = kit.openIdentification()
		setSystemTime(new Date((expiring.expiresAt + 1) * 1000))
		try {
			expect(await post(clerk, '/api/desk.assert', { id: expiring.id, principalId: person.id })).toEqual(notFound)
			expect(kit.identification(expiring.id)?.state).toBe('expired')
		} finally {
			setSystemTime()
		}
	})

	test("only a token the kit signed for the application is IAM's caller", async () => {
		const stand = kitIdentifications({
			issuer: 'https://iam.test',
			identifyUrl: 'https://kiosk.test/identify',
			verifies: (credential) => Promise.resolve(credential === 'signed'),
			principals: () => [],
		})
		const { id } = stand.open({ id: 'terminal-1', label: 'Entrance' })
		const as = (credential: string | null) => ({ app: 'kiosk@test', credential, requestId: 'r1', id })
		expect(await stand.rpc.inspectIdentification(as(null))).toEqual({ ok: false, reason: 'missing_token' })
		expect(await stand.rpc.assertIdentity({ ...as('forged'), principalId: 'person-1' })).toEqual({ ok: false, reason: 'invalid_token' })
		expect(await stand.rpc.cancelIdentification(as('forged'))).toEqual({ ok: false, reason: 'invalid_token' })
		expect(stand.stateOf(id)?.state).toBe('open')
		expect(await stand.rpc.cancelIdentification(as('signed'))).toEqual({ ok: true })
		expect(await stand.rpc.cancelIdentification(as('signed'))).toEqual({ ok: false, reason: 'not_found' })
	})

	test('one of two concurrent assertions consumes the identification', async () => {
		const stand = kitIdentifications({
			issuer: 'https://iam.test',
			identifyUrl: 'https://kiosk.test/identify',
			verifies: () => Promise.resolve(true),
			principals: () => [kit.testCaller([])],
		})
		const { id } = stand.open({ id: 'terminal-1', label: 'Entrance' })
		const input = { app: 'kiosk@test', credential: 'signed', requestId: 'r1', id, principalId: 'person-1' }
		const answers = await Promise.all([stand.rpc.assertIdentity(input), stand.rpc.assertIdentity(input)])
		expect(answers.map((answer) => answer.ok)).toEqual([true, false])
	})

	// Last: its kit takes the file's data layer over from `kit`.
	test('opens none where IAM would not, and none in a kit given its own terminals', async () => {
		expect(() => kit.openIdentification({ label: '' })).toThrow('a terminal has a non-empty id and label')
		const personal = defineApp(defineVocabulary({ app: 'personal', dimensions: {}, actions: { 'notes.read': 'Read notes' }, roles: {} }))
		const notes = personal.group({ callers: ['human'] }, (r) => ({
			ping: r.query({ output: z.strictObject({}), access: { action: 'notes.read', app: true } }).handle(() => ({})),
		}))
		const withoutTerminal = testKit(serve(personal.contract((c) => ({ api: c.rpc('/api', { notes }) })), { database: null }))
		expect(() => withoutTerminal.openIdentification()).toThrow('the contract declares no terminal')

		const none = (): Promise<{ ok: false; reason: 'not_found' }> => Promise.resolve({ ok: false, reason: 'not_found' })
		const terminals: IamTerminalRpc = { inspectIdentification: none, assertIdentity: none, cancelIdentification: none }
		await kit.drain()
		const own = testKit(served, { database: database.database, terminals })
		expect(() => own.openIdentification()).toThrow('this kit was given its own terminals transport')
		expect(own.identification('identification_unknown')).toBeUndefined()
	})
})
