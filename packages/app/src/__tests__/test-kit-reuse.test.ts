// Many test files in one process: a later `testKit` of the same application takes its data layer over from the earlier
// kit and boots on the contract this process already compiled and hashed natively. On SQLite, so it never skips.

import { createClient } from '@fabrika/app/client'
import { defineApp } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { contractDigest } from '@fabrika/auth-core'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing-sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { compileContract } from '../contract/compile'
import { kitContractDigest } from '../testing/kit'
import { tables } from './cloudflare-fixture/src/db/tables'
import { vocabulary } from './cloudflare-fixture/src/vocabulary'

const app = defineApp(vocabulary, tables)

/** What the kicked job waits for before it ends, so a test can hold it running. */
let finish: () => void = () => {}
let held: Promise<void> = Promise.resolve()

const settle = app.cron('0 3 * * *', { actions: ['notes.read'] }).handle(async () => {
	await held
})

const notes = app.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({
		input: z.strictObject({ workspaceId: z.string().min(1), title: z.string().min(1) }),
		output: z.strictObject({ id: z.uuid() }),
		access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' },
		kicks: ['settle'],
	}).handle(async ({ input, ctx }) => {
		const { id } = await ctx.db.target.notes.insert({ title: input.title })
		ctx.kick('settle')
		return { id }
	}),
	titles: r.query({
		input: z.strictObject({ workspaceId: z.string().min(1) }),
		output: z.strictObject({ titles: z.array(z.string()) }),
		access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' },
	}).handle(async ({ ctx }) => ({ titles: (await ctx.db.target.notes.list({ orderBy: [['title', 'asc']] })).items.map((note) => note.title) })),
}))

const contract = app.contract((c) => ({ api: c.rpc('/api', { notes }), health: c.health('/healthz'), jobs: { settle } }))
const implementation = serve(contract, { database: scoped(tables) })

const MIGRATIONS = new URL('./cloudflare-fixture/db/migrations/', import.meta.url)
const opened: { close(): Promise<void> }[] = []
afterAll(async () => {
	for (const database of opened) await database.close()
})

async function freshDatabase() {
	const database = await testDatabase({ migrations: MIGRATIONS, label: 'test-kit-reuse.test.ts' })
	opened.push(database)
	return database.database
}

const WORKSPACE = { type: 'workspace', value: 'w1' } as const

function writerOf(kit: ReturnType<typeof testKit<typeof contract>>) {
	return createClient(contract, 'api', { fetch: kit.browser(kit.testCaller([{ role: 'editor', scope: WORKSPACE }])) })
}

describe('a later test kit of the same application', () => {
	test("the kit's digest is the contract digest, taken natively", () => {
		const artifact = compileContract(contract, tables)
		expect(kitContractDigest(artifact)).toBe(contractDigest(artifact))
	})

	test('boots on the compiled contract and a fresh database, and the earlier kit refuses from then on', async () => {
		const first = testKit(implementation, { database: await freshDatabase() })
		await writerOf(first).notes.create({ workspaceId: 'w1', title: 'first file' })
		await first.drain()

		const second = testKit(implementation, { database: await freshDatabase() })
		expect(second.artifact).toBe(first.artifact)
		const api = writerOf(second)
		expect(await api.notes.titles({ workspaceId: 'w1' })).toEqual({ titles: [] })
		await api.notes.create({ workspaceId: 'w1', title: 'second file' })
		expect(await api.notes.titles({ workspaceId: 'w1' })).toEqual({ titles: ['second file'] })
		await second.drain()

		await expect(first.fetch('/healthz')).rejects.toThrow('was replaced by a later testKit')
		await expect(first.runJob('settle')).rejects.toThrow('was replaced by a later testKit')
	})

	test('is refused while the earlier kit still runs work its requests left', async () => {
		const first = testKit(implementation, { database: await freshDatabase() })
		held = new Promise((resolve) => {
			finish = resolve
		})
		await writerOf(first).notes.create({ workspaceId: 'w1', title: 'kicks a job' })
		const database = await freshDatabase()
		expect(() => testKit(implementation, { database })).toThrow('work its requests left')
		finish()
		await first.drain()
		const second = testKit(implementation, { database })
		expect(await writerOf(second).notes.titles({ workspaceId: 'w1' })).toEqual({ titles: [] })
		await second.drain()
	})

	test('is refused while a call of the earlier kit still runs, until a drain waited for it', async () => {
		const first = testKit(implementation, { database: await freshDatabase() })
		held = new Promise((resolve) => {
			finish = resolve
		})
		const run = first.runJob('settle')
		const database = await freshDatabase()
		expect(() => testKit(implementation, { database })).toThrow('still runs a request, a job')
		const drained = first.drain()
		finish()
		await drained
		expect(await run).toEqual({ status: 'succeeded', attempts: 1 })
		const second = testKit(implementation, { database })
		expect(await writerOf(second).notes.titles({ workspaceId: 'w1' })).toEqual({ titles: [] })
		await second.drain()
	})
})
