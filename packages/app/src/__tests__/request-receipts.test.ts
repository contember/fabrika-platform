// A repeated mutation answered from its receipt (ADR-0078), through the test kit, so the production proxy decision sits
// in front of boot. Each rule has its negative control: a repeat with the same key answers the stored output without
// running the work (without a key it runs again); another input or operation under the key is refused (the same input
// is answered); a caller the endpoint refuses gets no stored answer (the caller it admits does), and another principal's
// key is its own request; a response lost after the commit is answered from the receipt (a failure before the commit
// leaves none, so the retry runs); a stored output the current schema would change is refused (an unchanged one is
// answered). On the SQLite test database, so it never skips; the statements' Postgres half is
// `@fabrika/db`'s request-receipts.test.ts.

import { defineApp, defineVocabulary, file, redirect } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { scoped, type TypedColumnList } from '@fabrika/db'
import { REQUEST_RECEIPTS_TABLE } from '@fabrika/db/migrations'
import { defineTables } from '@fabrika/db/tables'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { runFixedStatement, sessionOf } from '../../../db/src/database'
import { createClient } from '../client'
import { columns as noteColumns } from './cloudflare-fixture/src/db/schema.generated'
import { tables as noteTables } from './cloudflare-fixture/src/db/tables'
import { vocabulary as noteVocabulary } from './cloudflare-fixture/src/vocabulary'

interface EntriesTable {
	id: string
	amount: number
	note: string
}

const columns: TypedColumnList<{ entries: EntriesTable }> = {
	entries: { columns: ['id', 'amount', 'note'], foreignKeys: [], timestamps: [] },
}

const vocabulary = defineVocabulary({
	app: 'ledger',
	dimensions: {},
	actions: { 'entries.read': 'Read entries', 'entries.write': 'Record entries' },
	roles: { clerk: { grants: ['entries.read', 'entries.write'] } },
})

const tables = defineTables(vocabulary, columns)({
	entries: {
		scope: { app: 'one ledger per application' },
		actions: { read: 'entries.read', insert: 'entries.write' },
		insert: ['amount', 'note'],
	},
})

/** Every run of a handler, by procedure: what tells a replay from a second run. */
const runs = { record: 0, other: 0, upload: 0, failing: 0, labelled: 0, refused: 0 }
/** The next run of `failing` throws after its write. */
let failNext = false

const app = defineApp(vocabulary, tables)

const entries = app.group({ callers: ['human'] }, (r) => ({
	record: r.mutation({
		input: z.strictObject({ amount: z.number().int(), note: z.string() }),
		output: z.strictObject({ id: z.string(), amount: z.number() }),
		access: { action: 'entries.write', app: true },
	}).handle(async ({ input, ctx }) => {
		runs.record++
		const { id } = await ctx.db.app.entries.insert({ amount: input.amount, note: input.note })
		return { id, amount: input.amount }
	}),
	other: r.mutation({
		input: z.strictObject({ amount: z.number().int(), note: z.string() }),
		output: z.strictObject({ id: z.string(), amount: z.number() }),
		access: { action: 'entries.write', app: true },
	}).handle(async ({ input, ctx }) => {
		runs.other++
		const { id } = await ctx.db.app.entries.insert({ amount: input.amount, note: input.note })
		return { id, amount: input.amount }
	}),
	failing: r.mutation({
		input: z.strictObject({ amount: z.number().int() }),
		output: z.strictObject({ id: z.string() }),
		access: { action: 'entries.write', app: true },
	}).handle(async ({ input, ctx }) => {
		runs.failing++
		const { id } = await ctx.db.app.entries.insert({ amount: input.amount, note: 'failing' })
		if (failNext) {
			failNext = false
			throw new Error('the work failed after its write')
		}
		return { id }
	}),
	upload: r.mutation({
		input: z.strictObject({ note: z.string(), scan: file('scans') }),
		output: z.strictObject({ run: z.number(), size: z.number() }),
		access: { action: 'entries.write', app: true },
	}).handle(({ input }) => {
		runs.upload++
		return { run: runs.upload, size: input.scan.size }
	}),
	// A union output whose answer came through the second branch: a second projection could pick the first.
	labelled: r.mutation({
		input: z.strictObject({ id: z.string() }),
		output: z.union([z.strictObject({ id: z.string(), n: z.optional(z.number()) }), z.strictObject({ id: z.string(), label: z.string() })]),
		access: { action: 'entries.write', app: true },
	}).handle(({ input }) => {
		runs.labelled++
		return { id: input.id, n: 'not a number', label: 'second branch' }
	}),
	moving: r.mutation({
		input: z.strictObject({}),
		output: redirect(),
		access: { action: 'entries.write', app: true },
	}).handle(() => {
		runs.refused++
		return { to: '/done' }
	}),
	large: r.mutation({
		input: z.strictObject({ note: z.string() }),
		output: z.strictObject({ text: z.string() }),
		access: { action: 'entries.write', app: true },
	}).handle(async ({ input, ctx }) => {
		await ctx.db.app.entries.insert({ amount: 1, note: input.note })
		return { text: 'ř'.repeat(40_000) }
	}),
	count: r.query({
		input: z.strictObject({}),
		output: z.strictObject({ n: z.number() }),
		access: { action: 'entries.read', app: true },
	}).handle(async ({ ctx }) => ({ n: await ctx.db.app.entries.count() })),
}))

const visitors = app.group({}, (r) => ({
	note: r.mutation({
		input: z.strictObject({ note: z.string() }),
		output: z.strictObject({ ok: z.boolean() }),
		access: { public: true },
		actions: ['entries.write'],
	}).handle(() => {
		runs.refused++
		return { ok: true }
	}),
}))

const contract = app.contract((c) => ({
	api: c.rpc('/api', { entries, visitors }),
	files: { scans: c.files({ types: ['text/plain'], maxBytes: 4096 }) },
}))

const directory = mkdtempSync(join(tmpdir(), 'fabrika-request-receipts-'))
mkdirSync(join(directory, 'migrations'))
writeFileSync(
	join(directory, 'migrations', '20261121120000_entries.sql'),
	`CREATE TABLE entries (
	id TEXT PRIMARY KEY,
	amount INTEGER NOT NULL,
	note TEXT NOT NULL
) STRICT;
`,
)
const database = await testDatabase({ migrations: join(directory, 'migrations'), label: 'request-receipts.test.ts' })
const kit = testKit(serve(contract, { database: scoped(tables) }), { database: database.database, files: new MemoryFileObjects() })
const clerkCaller = kit.testCaller([{ action: 'entries.read' }, { action: 'entries.write' }], { id: 'person-clerk' })
const clerk = kit.browser(clerkCaller)
const otherClerk = kit.browser(kit.testCaller([{ action: 'entries.read' }, { action: 'entries.write' }]))
/** The clerk's own principal after the write grant was taken away. */
const formerClerk = kit.browser(kit.testCaller([{ action: 'entries.read' }], { id: 'person-clerk' }))

// A target-scoped mutation: the proxy admits any holder of the action, and only the dispatcher's access form checks the
// workspace the input names. So it tells whether the receipt is read after that check.
const notesApp = defineApp(noteVocabulary, noteTables)
let noteRuns = 0
const notes = notesApp.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({
		input: z.strictObject({ workspaceId: z.string().min(1), title: z.string().min(1) }),
		output: z.strictObject({ id: z.string() }),
		access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' },
	}).handle(async ({ input, ctx }) => {
		noteRuns++
		const { id } = await ctx.db.target.notes.insert({ title: input.title })
		return { id }
	}),
}))
const notesContract = notesApp.contract((c) => ({ api: c.rpc('/api', { notes }) }))

// An endpoint that creates a scope: its access form creates it at IAM before any receipt could be read.
const startingVocabulary = defineVocabulary({
	app: 'notes',
	dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes', 'workspaces.create': 'Start a workspace' },
	roles: { owner: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
})
const startingTables = defineTables(startingVocabulary, noteColumns)({
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write' },
		insert: ['title'],
		update: ['title'],
		version: 'version',
		createdBy: 'created_by',
	},
})
const startingApp = defineApp(startingVocabulary, startingTables)
const workspaces = startingApp.group({ callers: ['human'] }, (r) => ({
	start: r.mutation({
		input: z.strictObject({ title: z.string() }),
		output: z.strictObject({ workspace: z.string() }),
		access: { action: 'workspaces.create', creates: 'workspace' },
	}).handle(({ ctx }) => {
		runs.refused++
		return { workspace: ctx.created.value }
	}),
}))
const startingContract = startingApp.contract((c) => ({ api: c.rpc('/api', { workspaces }) }))
const startingDatabase = await testDatabase({
	migrations: new URL('./cloudflare-fixture/db/migrations/', import.meta.url),
	label: 'request-receipts.test.ts starting',
})
const startingKit = testKit(serve(startingContract, { database: scoped(startingTables) }), { database: startingDatabase.database })
const notesDatabase = await testDatabase({
	migrations: new URL('./cloudflare-fixture/db/migrations/', import.meta.url),
	label: 'request-receipts.test.ts notes',
})
const notesKit = testKit(serve(notesContract, { database: scoped(noteTables) }), { database: notesDatabase.database })

afterAll(async () => {
	await startingDatabase.close()
	await notesDatabase.close()
	await database.close()
	rmSync(directory, { recursive: true, force: true })
})

let keys = 0
/** A key no other test used. */
const freshKey = (): string => `key-${++keys}-${crypto.randomUUID()}`

beforeEach(() => {
	runs.record = 0
	runs.other = 0
	runs.upload = 0
	runs.failing = 0
	runs.labelled = 0
	runs.refused = 0
	failNext = false
})

async function call(fetch: typeof clerk, procedure: string, input: unknown, key?: string): Promise<Response> {
	return await fetch(`/api/entries.${procedure}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
		body: JSON.stringify(input),
	})
}

async function count(): Promise<number> {
	const response = await call(clerk, 'count', {})
	expect(response.status).toBe(200)
	const body: { result: { n: number } } = await response.json()
	return body.result.n
}

async function errorType(response: Response): Promise<string> {
	const body: { error?: { type?: string } } = await response.json()
	return body.error?.type ?? ''
}

/** The receipts table, read past the data layer: a test's own inspection and the stand-in for an older release's write. */
async function receiptsSql(text: string, parameters: readonly string[] = []): Promise<readonly unknown[]> {
	return await runFixedStatement(sessionOf({ database: database.database }), text, parameters)
}

describe('a repeated request with the same key', () => {
	test('is answered with the stored output, and its work does not run again', async () => {
		const before = await count()
		const key = freshKey()
		const first = await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)
		expect(first.status).toBe(200)
		const answer = await first.text()
		const again = await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)
		expect(again.status).toBe(200)
		expect(await again.text()).toBe(answer)
		expect(runs.record).toBe(1)
		expect(await count()).toBe(before + 1)
	})

	test('negative control: without a key the same request runs again', async () => {
		const before = await count()
		const first = await call(clerk, 'record', { amount: 5, note: 'coffee' })
		const again = await call(clerk, 'record', { amount: 5, note: 'coffee' })
		expect([first.status, again.status]).toEqual([200, 200])
		expect(await again.text()).not.toBe(await first.text())
		expect(runs.record).toBe(2)
		expect(await count()).toBe(before + 2)
	})

	test("the typed client sends the key as the call's requestKey", async () => {
		const api = createClient(contract, 'api', { baseUrl: kit.origin, fetch: clerk })
		const requestKey = freshKey()
		const first = await api.entries.record({ amount: 7, note: 'tea' }, { requestKey })
		expect(await api.entries.record({ amount: 7, note: 'tea' }, { requestKey })).toEqual(first)
		expect(runs.record).toBe(1)
		// Negative control: a new key is a new request.
		expect(await api.entries.record({ amount: 7, note: 'tea' }, { requestKey: freshKey() })).not.toEqual(first)
		expect(runs.record).toBe(2)
	})
})

describe('a different request under the same key', () => {
	test('another input is refused with 409, and nothing runs', async () => {
		const key = freshKey()
		expect((await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)).status).toBe(200)
		const before = await count()
		const changed = await call(clerk, 'record', { amount: 6, note: 'coffee' }, key)
		expect(changed.status).toBe(409)
		expect(await errorType(changed)).toBe('request_key_reused')
		expect(runs.record).toBe(1)
		expect(await count()).toBe(before)
		// Negative control: the same input under the key is still answered.
		expect((await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)).status).toBe(200)
	})

	test('the same input to another operation is refused with 409, and nothing runs', async () => {
		const key = freshKey()
		expect((await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)).status).toBe(200)
		const other = await call(clerk, 'other', { amount: 5, note: 'coffee' }, key)
		expect(other.status).toBe(409)
		expect(await errorType(other)).toBe('request_key_reused')
		expect(runs.other).toBe(0)
		// Negative control: under a key of its own the operation runs.
		expect((await call(clerk, 'other', { amount: 5, note: 'coffee' }, freshKey())).status).toBe(200)
		expect(runs.other).toBe(1)
	})

	test('a file with other bytes, or under another name, is another input', async () => {
		const upload = async (bytes: string, key: string) => {
			const form = new FormData()
			form.append('input', JSON.stringify({ note: 'receipt scan' }))
			form.append('scan', new File([bytes], 'scan.txt', { type: 'text/plain' }))
			return await clerk('/api/entries.upload', { method: 'POST', headers: { 'Idempotency-Key': key }, body: form })
		}
		const key = freshKey()
		const first = await upload('total 12.50', key)
		expect(first.status).toBe(200)
		const answer = await first.text()
		// Negative control: the same bytes, uploaded again with a new pending id, are the same input.
		const same = await upload('total 12.50', key)
		expect(same.status).toBe(200)
		expect(await same.text()).toBe(answer)
		expect(runs.upload).toBe(1)
		const other = await upload('total 99.50', key)
		expect(other.status).toBe(409)
		expect(await errorType(other)).toBe('request_key_reused')
		const form = new FormData()
		form.append('input', JSON.stringify({ note: 'receipt scan' }))
		form.append('scan', new File(['total 12.50'], 'renamed.txt', { type: 'text/plain' }))
		const renamed = await clerk('/api/entries.upload', { method: 'POST', headers: { 'Idempotency-Key': key }, body: form })
		expect(renamed.status).toBe(409)
		expect(runs.upload).toBe(1)
	})
})

describe('authorization before a stored answer', () => {
	test('the same principal without the endpoint action gets 403, not the stored answer', async () => {
		const key = freshKey()
		const first = await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)
		expect(first.status).toBe(200)
		const answer: { result: { id: string } } = await first.json()
		const refused = await call(formerClerk, 'record', { amount: 5, note: 'coffee' }, key)
		expect(refused.status).toBe(403)
		expect(await refused.text()).not.toContain(answer.result.id)
		// Negative control: the principal that holds the action is answered from the receipt.
		const again: { result: { id: string } } = await (await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)).json()
		expect(again.result.id).toBe(answer.result.id)
		expect(runs.record).toBe(1)
	})

	test('the same principal that no longer holds the action in the target workspace gets 403 from the access form', async () => {
		const inW1 = { type: 'workspace', value: 'w1' } as const
		const inW2 = { type: 'workspace', value: 'w2' } as const
		const writer = notesKit.browser(notesKit.testCaller([{ action: 'notes.write', scope: inW1 }], { id: 'person-writer' }))
		// The proxy admits this one (it holds the action, in another workspace); only the dispatcher refuses it.
		const moved = notesKit.browser(notesKit.testCaller([{ action: 'notes.write', scope: inW2 }], { id: 'person-writer' }))
		const create = (fetch: typeof writer, key: string) =>
			fetch('/api/notes.create', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
				body: JSON.stringify({ workspaceId: 'w1', title: 'Minutes' }),
			})
		noteRuns = 0
		const key = freshKey()
		const first = await create(writer, key)
		expect(first.status).toBe(200)
		const answer: { result: { id: string } } = await first.json()
		const refused = await create(moved, key)
		expect(refused.status).toBe(403)
		expect(await refused.text()).not.toContain(answer.result.id)
		// Negative control: the holder in w1 is answered from the receipt, and the work ran once.
		const again: { result: { id: string } } = await (await create(writer, key)).json()
		expect(again.result.id).toBe(answer.result.id)
		expect(noteRuns).toBe(1)
	})

	test("another principal's same key is a request of its own, never the stored answer", async () => {
		const key = freshKey()
		const mine: { result: { id: string } } = await (await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)).json()
		const theirs = await call(otherClerk, 'record', { amount: 5, note: 'coffee' }, key)
		expect(theirs.status).toBe(200)
		const body: { result: { id: string } } = await theirs.json()
		expect(body.result.id).not.toBe(mine.result.id)
		expect(runs.record).toBe(2)
	})
})

describe('a response lost after the commit', () => {
	test('is answered from the receipt by the retry, which writes nothing', async () => {
		const before = await count()
		const key = freshKey()
		// The first answer never reaches the client: its body is not read.
		const lost = await call(clerk, 'record', { amount: 12, note: 'lunch' }, key)
		expect(lost.status).toBe(200)
		await lost.body?.cancel()
		const retry = await call(clerk, 'record', { amount: 12, note: 'lunch' }, key)
		expect(retry.status).toBe(200)
		const body: { result: { amount: number } } = await retry.json()
		expect(body.result.amount).toBe(12)
		expect(runs.record).toBe(1)
		expect(await count()).toBe(before + 1)
	})

	test('negative control: a failure after the write and before the commit leaves no receipt, so the retry runs once', async () => {
		const before = await count()
		const key = freshKey()
		failNext = true
		expect((await call(clerk, 'failing', { amount: 3 }, key)).status).toBe(500)
		expect(await count()).toBe(before)
		expect(await receiptsSql(`select request_key from ${REQUEST_RECEIPTS_TABLE} where request_key = ?1`, [key])).toHaveLength(0)
		const retry = await call(clerk, 'failing', { amount: 3 }, key)
		expect(retry.status).toBe(200)
		expect(runs.failing).toBe(2)
		expect(await count()).toBe(before + 1)
	})
})

describe('a stored output the current schema would change', () => {
	async function storedFor(key: string): Promise<string> {
		const [row] = await receiptsSql(`select output from ${REQUEST_RECEIPTS_TABLE} where request_key = ?1`, [key])
		const output: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'output') : null
		if (typeof output !== 'string') throw new Error('no receipt was recorded')
		return output
	}

	for (
		const [label, rewrite] of [
			['a field the schema drops', (stored: { result: Record<string, unknown> }) => ({ result: { ...stored.result, legacy: true } })],
			['a value the schema refuses', (stored: { result: Record<string, unknown> }) => ({ result: { ...stored.result, amount: 'five' } })],
		] as const
	) {
		test(`is refused with 409 when it holds ${label}, and the work does not run`, async () => {
			const key = freshKey()
			expect((await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)).status).toBe(200)
			const before = await count()
			// An older release stored an answer the current output schema would change.
			const stored: { result: Record<string, unknown> } = JSON.parse(await storedFor(key))
			await receiptsSql(`update ${REQUEST_RECEIPTS_TABLE} set output = ?1 where request_key = ?2`, [JSON.stringify(rewrite(stored)), key])
			const replay = await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)
			expect(replay.status).toBe(409)
			expect(await errorType(replay)).toBe('request_replay_incompatible')
			expect(runs.record).toBe(1)
			expect(await count()).toBe(before)
		})
	}

	test('negative control: an answer a union produced through its second branch is answered unchanged', async () => {
		const key = freshKey()
		const first = await call(clerk, 'labelled', { id: 'e1' }, key)
		expect(first.status).toBe(200)
		const answer = await first.json()
		expect(answer).toEqual({ result: { id: 'e1', label: 'second branch' } })
		const replay = await call(clerk, 'labelled', { id: 'e1' }, key)
		expect(replay.status).toBe(200)
		expect(await replay.json()).toEqual(answer)
		expect(runs.labelled).toBe(1)
	})

	test('negative control: a stored output with its keys in another order is answered', async () => {
		const key = freshKey()
		const first: { result: { id: string; amount: number } } = await (await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)).json()
		await receiptsSql(`update ${REQUEST_RECEIPTS_TABLE} set output = ?1 where request_key = ?2`, [
			JSON.stringify({ result: { amount: first.result.amount, id: first.result.id } }),
			key,
		])
		const replay = await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)
		expect(replay.status).toBe(200)
		expect(await replay.json()).toEqual(first)
	})
})

describe('where a key is not accepted', () => {
	test('a redirect, a public procedure and an endpoint that creates a scope refuse it with 400, and nothing runs', async () => {
		const moving = await call(clerk, 'moving', {}, freshKey())
		expect(moving.status).toBe(400)
		expect(await errorType(moving)).toBe('request_key_not_accepted')
		const visitor = await kit.fetch('/api/visitors.note', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Idempotency-Key': freshKey() },
			body: JSON.stringify({ note: 'hi' }),
		})
		expect(visitor.status).toBe(400)
		expect(await errorType(visitor)).toBe('request_key_not_accepted')
		const starter = startingKit.browser(startingKit.testCaller([{ action: 'workspaces.create' }]))
		const start = (headers: Record<string, string>) =>
			starter('/api/workspaces.start', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...headers },
				body: JSON.stringify({ title: 'Ops' }),
			})
		const starting = await start({ 'Idempotency-Key': freshKey() })
		expect(starting.status).toBe(400)
		expect(await errorType(starting)).toBe('request_key_not_accepted')
		expect(runs.refused).toBe(0)
		// Negative control: without a key each of them runs.
		expect((await call(clerk, 'moving', {})).status).toBe(303)
		expect(
			(await kit.fetch('/api/visitors.note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'hi' }) }))
				.status,
		)
			.toBe(200)
		expect((await start({})).status).toBe(200)
		expect(runs.refused).toBe(3)
	})

	test('an output larger than a receipt keeps fails the request, and nothing it wrote is kept', async () => {
		const before = await count()
		const key = freshKey()
		const large = await call(clerk, 'large', { note: 'large' }, key)
		expect(large.status).toBe(500)
		expect(await count()).toBe(before)
		expect(await receiptsSql(`select request_key from ${REQUEST_RECEIPTS_TABLE} where request_key = ?1`, [key])).toHaveLength(0)
		// Negative control: without a key the same output is answered.
		expect((await call(clerk, 'large', { note: 'large' })).status).toBe(200)
		expect(await count()).toBe(before + 1)
	})

	test('a query, and a malformed key, are refused with 400 before anything runs', async () => {
		const query = await call(clerk, 'count', {}, freshKey())
		expect(query.status).toBe(400)
		expect(await errorType(query)).toBe('request_key_not_accepted')
		const malformed = await call(clerk, 'record', { amount: 5, note: 'coffee' }, 'no spaces allowed')
		expect(malformed.status).toBe(400)
		expect(await errorType(malformed)).toBe('request_key_invalid')
		expect(runs.record).toBe(0)
		// Negative control: the key as a quoted string is the same key.
		const key = freshKey()
		expect((await call(clerk, 'record', { amount: 5, note: 'coffee' }, key)).status).toBe(200)
		expect((await call(clerk, 'record', { amount: 5, note: 'coffee' }, `"${key}"`)).status).toBe(200)
		expect(runs.record).toBe(1)
	})
})
