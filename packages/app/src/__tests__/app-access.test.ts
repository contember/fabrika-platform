// Application-wide data (WU23a) through the production proxy decision and a REAL Postgres: an `app` endpoint is
// admitted only for a global grant of its action, and its `ctx.db.app` writes the application tables and reads every
// candidate; the isolation kits probe the same endpoints and tables. Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { createClient, download, RpcError } from '@fabrika/app/client'
import { type App, compileContract, type Declared, type EndpointContext, type KitTypes, type Unavailable } from '@fabrika/app/contract'
import { type AppCapability, serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { appPolicyIsolationKit, endpointAccessKit, policyIsolationKit } from '@fabrika/app/testing/isolation'
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
type Scoped<A extends string> = EndpointContext<
	Kit,
	'human',
	'mutation',
	{ readonly action: A; readonly on: 'candidate'; readonly from: 'id' },
	Declared<never, never, never, never>
>
type Over<A extends string> = EndpointContext<
	Kit,
	'human',
	'query',
	{ readonly action: A; readonly over: 'candidate' },
	Declared<never, never, never, never>
>

/** The types of an `app` endpoint: its capability, every table of the application in its handle, and no target. */
export type AppContext = [
	Expect<Equal<AppMutation['app'], AppCapability<'candidates.read'>>>,
	Expect<Equal<Reached<AppMutation['db']['app']>, 'candidates' | 'exports' | 'positions' | 'reasons'>>,
	Expect<AppMutation['target'] extends Unavailable<string> ? true : false>,
	Expect<AppMutation['members'] extends Unavailable<string> ? true : false>,
]

type AppQuery<A extends string> = EndpointContext<
	Kit,
	'human',
	'query',
	{ readonly action: A; readonly app: true },
	Declared<never, never, never, never>
>
type Candidates<A extends string> = AppQuery<A>['db']['app']['candidates']

/** An action of the candidates' appRead lists every row; one of their appCount counts them and lists none. */
export type AppReachContext = [
	Expect<Equal<Reached<Candidates<'candidates.export'>>, 'list' | 'all' | 'count' | 'aggregate'>>,
	Expect<Equal<Reached<Candidates<'candidates.count'>>, 'count'>>,
	Expect<Equal<Reached<Candidates<'positions.read'>>, never>>,
]

/** A scoped site reads each application table whose read action is its own, every row and read-only, and no other. */
export type ScopedAppContext = [
	Expect<Equal<Reached<Scoped<'candidates.review'>['db']['app']>, 'reasons'>>,
	Expect<Equal<Reached<Over<'audit.read'>['db']['app']>, 'exports'>>,
	Expect<Equal<Reached<Scoped<'candidates.read'>['db']['app']>, never>>,
	Expect<Equal<Reached<Scoped<'candidates.review'>['db']['app']['reasons']>, 'list' | 'all' | 'count' | 'aggregate' | 'get'>>,
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
	test('the checker accepts the fixture', async () => {
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
	const reviewer = kit.testCaller([{ action: 'candidates.export' }, { action: 'candidates.count' }, { action: 'audit.read' }])
	const hr = createClient(contract, 'api', { fetch: kit.browser(reviewer) })

	describe('ctx.db.app through the proxy decision', () => {
		test('a caller who holds the action in one scope only is refused by the proxy', async () => {
			const scopedAdmin = as([{ action: 'positions.manage', scope: { type: 'candidate', value: crypto.randomUUID() } }])
			expect(await statusOf(scopedAdmin.admin.add({ title: 'Nurse' }))).toBe(403)
			const scopedCounter = as([{ action: 'candidates.count', scope: { type: 'candidate', value: crypto.randomUUID() } }])
			expect(await statusOf(scopedCounter.admin.counts())).toBe(403)
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

		test('a decision on one candidate reads the reasons by their read action, and refuses an unknown or retired one with 400', async () => {
			const registrar = as([{ action: 'reasons.manage' }])
			const kept = await registrar.admin.reason({ label: `Kept ${crypto.randomUUID()}` })
			const retired = await registrar.admin.reason({ label: `Retired ${crypto.randomUUID()}` })
			await registrar.admin.retire({ id: retired.id, expectVersion: 1 })
			const worlds = await postgres.seedWorlds(tables, 'candidates')
			const reviewer = as([{ action: 'candidates.review', scope: { type: 'candidate', value: worlds.own.key } }])
			const decide = (reasonId: string | null, expectVersion: number) => reviewer.admin.decide({ id: worlds.own.key, expectVersion, reasonId })
			const refusal = async (reasonId: string): Promise<string> => {
				try {
					await decide(reasonId, 1)
				} catch (error) {
					if (error instanceof RpcError) return `${error.httpStatus} ${error.message}`
					throw error
				}
				return 'answered'
			}
			const unknown = crypto.randomUUID()
			expect(await refusal(unknown)).toBe(`400 the reason ${unknown} is unknown or retired`)
			expect(await refusal(retired.id)).toBe(`400 the reason ${retired.id} is unknown or retired`)
			expect(await decide(kept.id, 1)).toEqual({ id: worlds.own.key, version: 2 })
			expect(await decide(null, 2)).toEqual({ id: worlds.own.key, version: 3 })
		})

		test('the export and the counts have actions of their own: a global holder of only the read action gets 403 on both', async () => {
			const reader = as([{ action: 'candidates.read' }, { action: 'audit.read' }])
			expect(await statusOf(download(reader.admin.export, {}))).toBe(403)
			expect(await statusOf(reader.admin.counts())).toBe(403)
			const operator = as([{ action: 'candidates.count' }])
			expect((await operator.admin.counts()).items.length).toBeGreaterThan(0)
			expect(await statusOf(download(operator.admin.export, {}))).toBe(403)
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

	describe('the isolation kits over application-wide data', () => {
		const access = endpointAccessKit(serve(contract, { database: scoped(tables) }), tables, postgres)
		const UUID = '00000000-0000-4000-8000-000000000000'

		test('the proxy refuses a holder of the action in one scope, and admits a global holder, at every app endpoint', async () => {
			const endpoints: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
				['api.admin.add', { title: 'Nurse' }],
				['api.admin.audit', {}],
				['api.admin.columns', { id: UUID }],
				['api.admin.counts', {}],
				['api.admin.drop', { expectVersion: 1, id: UUID }],
				['api.admin.edit', { active: false, expectVersion: 1, id: UUID, title: 'x' }],
				['api.admin.export', {}],
				['api.admin.positions', {}],
				['api.admin.reason', { label: 'x' }],
				['api.admin.retire', { expectVersion: 1, id: UUID }],
			]
			for (const [endpoint, input] of endpoints) {
				expect([endpoint, await access.scoped(endpoint, input)]).toEqual([endpoint, { status: 403 }])
				expect([endpoint, await access.global(endpoint, input)]).toEqual([endpoint, { answered: true }])
			}
		})

		test('the on endpoint: the candidate of another scope is 404, its answer holds nothing of it, its own is reached', async () => {
			const input = { expectVersion: 1, id: UUID, reasonId: null }
			expect(await access.denied('api.admin.decide', input)).toEqual({ status: 404 })
			expect(await access.leaked('api.admin.decide', input)).toEqual({ answered: true, leaked: [] })
			expect(await access.own('api.admin.decide', input)).toEqual({ status: 200 })
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
			expect(await positions.scopedList()).toEqual({ status: 200, rows: ['own'] })
			expect(await positions.scopedListWithOther()).toEqual({ status: 200, refused: true })
		})

		test('the policy probe of an application table without delete: a scoped site of its read action reads every row, of another action none', async () => {
			const reasons = appPolicyIsolationKit(contract, tables, 'reasons', postgres)
			expect(await reasons.get('global')).toMatchObject({ status: 200 })
			expect((await reasons.get('scoped')).status).toBe(403)
			expect(await reasons.list('global')).toEqual({ status: 200, rows: ['own'] })
			expect((await reasons.list('scoped')).status).toBe(403)
			expect(await reasons.insert('global')).toEqual({ status: 200 })
			expect((await reasons.insert('scoped')).status).toBe(403)
			expect(await reasons.update('global')).toEqual({ status: 200 })
			expect((await reasons.update('scoped')).status).toBe(403)
			expect(await reasons.updateWithRead()).toEqual({ status: 200, refused: true })
			expect(await reasons.scopedList()).toEqual({ status: 200, rows: ['own'] })
			expect(await reasons.scopedListWithOther()).toEqual({ status: 200, refused: true })
		})

		test('the policy probe of a dimension table: a caller of one candidate reaches no row of another, and no column with its own read action', async () => {
			const candidates = policyIsolationKit(contract, tables, 'candidates', postgres)
			const own = await candidates.get('own')
			expect(own.status).toBe(200)
			expect(own.columns).not.toContain('notes')
			expect(own.columns).not.toContain('score')
			expect((await candidates.get('other')).status).toBe(404)
			expect(await candidates.list()).toEqual({ status: 200, rows: ['own'] })
			expect(await candidates.count()).toEqual({ status: 200, count: '1' })
		})

		test("the policy probe of the candidates' app reach: appRead lists every row with its own columns, appCount counts every row and lists or groups none", async () => {
			const candidates = policyIsolationKit(contract, tables, 'candidates', postgres)
			expect(await candidates.appList('candidates.export')).toEqual({ status: 200, rows: ['own', 'other'] })
			expect(await candidates.appColumns('candidates.export')).toEqual({ status: 200, leaked: [], missing: [] })
			expect(await candidates.appCount('candidates.count')).toEqual({ status: 200, counted: 2 })
			expect(await candidates.appListWithCount('candidates.count')).toEqual({ status: 200, refused: true })
			expect(await candidates.appGroupWithCount('candidates.count')).toEqual({ status: 200, refused: true })
		})

		test('the probe of an append-only application table inserts with its insert action alone', async () => {
			const exports = appPolicyIsolationKit(contract, tables, 'exports', postgres)
			expect(await exports.get('global')).toMatchObject({ status: 200 })
			expect((await exports.get('scoped')).status).toBe(403)
			expect(await exports.insert('global')).toEqual({ status: 200 })
			expect(await exports.list('global')).toEqual({ status: 200, rows: ['own'] })
			expect((await exports.list('scoped')).status).toBe(403)
			expect((await exports.insert('scoped')).status).toBe(403)
			expect(await exports.scopedList()).toEqual({ status: 200, rows: ['own'] })
			expect(await exports.scopedListWithOther()).toEqual({ status: 200, refused: true })
		})
	})
}
