// Application-wide data (WU23a) through the production proxy decision and a REAL Postgres: an `app` endpoint is
// admitted only for a global grant of its action, and its `ctx.db.app` writes the application tables and reads every
// candidate. The generated tests' kits probe the same endpoints and tables; the fixture's own generated tests
// (`app-wide-fixture/src/**/__tests__/`) are committed and current. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { createClient, download, RpcError } from '@fabrika/app/client'
import { type App, compileContract, type Declared, type EndpointContext, type KitTypes, type Unavailable } from '@fabrika/app/contract'
import { type AppCapability, serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { appPolicyIsolationKit, endpointAccessKit } from '@fabrika/app/testing/isolation'
import { checkApplication } from '@fabrika/check'
import { scoped } from '@fabrika/db'
import { testDatabase } from '@fabrika/db/testing'
import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { contract } from './app-wide-fixture/fabrika.contract'
import type { app } from './app-wide-fixture/src/app-kit'
import { tables } from './app-wide-fixture/src/db/tables'

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type Kit = typeof app extends App<infer K extends KitTypes> ? K : never
type AppMutation = EndpointContext<
	Kit,
	'human',
	'mutation',
	{ readonly action: 'candidates.read'; readonly app: true },
	Declared<never, never, never, never>
>
type Reached<H> = { [P in keyof H]: H[P] extends Unavailable<string> ? never : P }[keyof H]

/** The types of an `app` endpoint: its capability, every table of the application in its handle, and no target. */
export type AppContext = [
	Expect<Equal<AppMutation['app'], AppCapability<'candidates.read'>>>,
	Expect<Equal<Reached<AppMutation['db']['app']>, 'candidates' | 'exports' | 'positions'>>,
	Expect<AppMutation['target'] extends Unavailable<string> ? true : false>,
	Expect<AppMutation['members'] extends Unavailable<string> ? true : false>,
]

const fixtureRoot = join(import.meta.dir, 'app-wide-fixture')
const postgres = await testDatabase({ migrations: join(fixtureRoot, 'db', 'migrations'), label: 'app-access.test.ts' })

afterAll(async () => {
	await postgres?.close()
})

const statusOf = async (call: Promise<unknown>): Promise<number> => {
	try {
		await call
		return 200
	} catch (error) {
		if (error instanceof RpcError && error.httpStatus !== undefined) return error.httpStatus
		throw error
	}
}

describe('the app access form in the artifact', () => {
	test('the checker accepts the fixture, and its committed generated tests are what the scaffold writes', async () => {
		expect(await checkApplication({ root: fixtureRoot })).toEqual([])
	})

	test('an app endpoint requires its action with the app form, and an application table keeps its reason and key', () => {
		const artifact = compileContract(contract, tables)
		expect(artifact.endpoints.find((row) => row.id === 'api.admin.add')?.requirement).toEqual({
			kind: 'action',
			action: 'positions.manage',
			access: { form: 'app' },
		})
		expect(artifact.tables['positions']?.scope).toEqual({ mode: 'app', reason: 'the open positions an administrator edits', key: 'id' })
	})
})

if (postgres !== null) {
	const kit = testKit(serve(contract, { database: scoped(tables) }), { database: postgres.database })
	const as = (grants: Parameters<typeof kit.testCaller>[0]) => createClient(contract, 'api', { fetch: kit.browser(kit.testCaller(grants)) })
	const admin = as([{ action: 'positions.read' }, { action: 'positions.manage' }])
	const reviewer = kit.testCaller([{ action: 'candidates.read' }, { action: 'audit.read' }])
	const hr = createClient(contract, 'api', { fetch: kit.browser(reviewer) })

	describe('ctx.db.app through the proxy decision', () => {
		test('a caller who holds the action in one scope only is refused by the proxy', async () => {
			const scopedAdmin = as([{ action: 'positions.manage', scope: { type: 'candidate', value: crypto.randomUUID() } }])
			expect(await statusOf(scopedAdmin.admin.add({ title: 'Nurse' }))).toBe(403)
			const scopedReader = as([{ action: 'candidates.read', scope: { type: 'candidate', value: crypto.randomUUID() } }])
			expect(await statusOf(scopedReader.admin.counts())).toBe(403)
		})

		test('a global holder inserts, reads, updates under expectVersion and removes a row of an application table', async () => {
			const added = await admin.admin.add({ title: `Surgeon ${crypto.randomUUID()}` })
			expect(added.version).toBe(1)
			expect((await admin.admin.positions()).items.some((item) => item.id === added.id)).toBe(true)
			const edited = await admin.admin.edit({ id: added.id, title: 'Head surgeon', active: false, expectVersion: 1 })
			expect(edited).toEqual({ id: added.id, version: 2 })
			expect(await statusOf(admin.admin.edit({ id: added.id, title: 'Stale', active: true, expectVersion: 1 }))).toBe(409)
			expect(await admin.admin.columns({ id: added.id })).toEqual({ columns: ['active', 'created_by', 'id', 'title', 'version'] })
			expect(await admin.admin.drop({ id: added.id, expectVersion: 2 })).toEqual({ done: true })
			expect(await statusOf(admin.admin.columns({ id: added.id }))).toBe(404)
		})

		test('an app endpoint reads every candidate with its action, and the export writes its log row in the same transaction', async () => {
			const worlds = await postgres.seedWorlds(tables, 'candidates')
			const counts = await hr.admin.counts()
			expect(counts.items.reduce((total, item) => total + Number(item.count), 0)).toBeGreaterThanOrEqual(2)
			const before = (await hr.admin.audit()).items.length
			const file = await download(hr.admin.export, {})
			const text = await file.text()
			expect(text).toContain(worlds.own.key)
			expect(text).toContain(worlds.other.key)
			const log = (await hr.admin.audit()).items
			expect(log.length).toBe(before + 1)
			expect(log.at(-1)?.createdBy).toBe(reviewer.id)
		})
	})

	describe('the generated tests of application-wide data', () => {
		const access = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, postgres)

		test('the proxy refuses a holder of the action in one scope, and admits a global holder', async () => {
			expect(await access.scoped('api.admin.add', { title: 'Nurse' })).toEqual({ status: 403 })
			expect(await access.global('api.admin.add', { title: 'Nurse' })).toEqual({ answered: true })
			expect(await access.scoped('api.admin.export', {})).toEqual({ status: 403 })
			expect(await access.global('api.admin.export', {})).toEqual({ answered: true })
		})

		test('the policy probe of an application table: only a global holder of its actions reaches a row', async () => {
			const positions = appPolicyIsolationKit(contract, tables, 'positions', postgres)
			expect(await positions.get('global')).toMatchObject({ status: 200 })
			expect((await positions.get('scoped')).status).toBe(403)
			expect(await positions.list('global')).toEqual({ status: 200, rows: ['own'] })
			expect((await positions.list('scoped')).status).toBe(403)
			expect(await positions.insert('global')).toEqual({ status: 200 })
			expect((await positions.insert('scoped')).status).toBe(403)
			expect(await positions.update('global')).toEqual({ status: 200 })
			expect((await positions.update('scoped')).status).toBe(403)
			expect(await positions.remove('global')).toEqual({ status: 200 })
			expect((await positions.remove('scoped')).status).toBe(403)
			expect(await positions.updateWithRead()).toEqual({ status: 200, refused: true })
			expect(await positions.removeWithRead()).toEqual({ status: 200, refused: true })
		})

		test('the probe of an append-only application table inserts with its insert action alone', async () => {
			const exports = appPolicyIsolationKit(contract, tables, 'exports', postgres)
			expect(await exports.insert('global')).toEqual({ status: 200 })
			expect(await exports.list('global')).toEqual({ status: 200, rows: ['own'] })
			expect((await exports.insert('scoped')).status).toBe(403)
		})
	})
}
