// The browsers' Web Push subscriptions (ADR-0088) on both dialects: a subscription is bound to the principal who
// recorded it and never rebound to another; a replacement is accepted only from the old endpoint's own principal, from
// its live row or its tombstone within the retention, and carries its cursor; a principal keeps at most ten; a removal
// reaches only the caller's own row. SQLite always runs (a bun:sqlite stand-in for a Durable Object's storage); Postgres
// skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { openPostgres } from '@fabrika/db/postgres'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { type Database, type Session, sessionOf } from '../database'
import { FRAMEWORK_MIGRATIONS, PUSH_SUBSCRIPTIONS_TABLE } from '../migrations'
import { PUSH_SUBSCRIPTION_LIMITS, type PushSubscriptionKeys, pushSubscriptions } from '../push-subscriptions'
import { sqliteFramework } from './fixtures/sqlite-framework'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`push-subscriptions.test.ts: the Postgres half skipped: set ${URL_VAR} to run it`)
}

const push = pushSubscriptions()
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1_000
const ALICE = 'user:alice'
const BOB = 'user:bob'

const id = (n: number) => `0190f000-0000-7000-8000-${String(n).padStart(12, '0')}`
const endpoint = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`
const keys = (name: string, vapidKey = 'K1'): PushSubscriptionKeys => ({ endpoint: endpoint(name), p256dh: `p-${name}`, auth: `a-${name}`, vapidKey })

/** What one dialect's half needs: a session, and the rows of the table, read past the data layer. */
interface Backend {
	session(): Session
	rows(where?: string): Promise<readonly Record<string, unknown>[]>
	exec(statement: string): Promise<void>
}

function suite(name: string, backend: () => Backend, skip: boolean): void {
	describe.skipIf(skip)(`push subscriptions on ${name}`, () => {
		test("a browser's endpoint is the caller's, another principal's, or unknown", async () => {
			const session = backend().session()
			expect(await push.binding(session, ALICE, endpoint('e1'))).toBe('unknown')
			expect(await push.record(session, ALICE, id(1), keys('e1'), null, NOW)).toBe('recorded')
			expect(await push.binding(session, ALICE, endpoint('e1'))).toBe('mine')
			expect(await push.binding(session, BOB, endpoint('e1'))).toBe('other')
		})

		test('a record of the same endpoint keeps its row and takes the new keys; another principal never takes it over', async () => {
			const session = backend().session()
			await push.record(session, ALICE, id(1), keys('e1'), null, NOW)
			expect(await push.record(session, ALICE, id(2), { ...keys('e1', 'K2'), p256dh: 'p-new' }, null, NOW + 1)).toBe('recorded')
			expect(await backend().rows()).toMatchObject([{ id: id(1), principal: ALICE, p256dh: 'p-new', vapid_key: 'K2' }])
			expect(await push.record(session, BOB, id(3), keys('e1'), null, NOW + 2)).toBe('taken')
			expect(await backend().rows()).toMatchObject([{ id: id(1), principal: ALICE, p256dh: 'p-new' }])
		})

		test("a replacement of the caller's own endpoint moves its cursor to the new row, and the old row goes", async () => {
			const session = backend().session()
			await push.record(session, ALICE, id(1), keys('old'), null, NOW)
			await backend().exec(`update ${PUSH_SUBSCRIPTIONS_TABLE} set cursor = 'n-7' where endpoint = '${endpoint('old')}'`)
			expect(await push.record(session, ALICE, id(2), keys('new', 'K2'), endpoint('old'), NOW + 1)).toBe('recorded')
			expect(await backend().rows()).toMatchObject([{ id: id(2), endpoint: endpoint('new'), cursor: 'n-7', vapid_key: 'K2' }])
		})

		test("a replacement of another principal's endpoint, or of one nobody recorded, is refused and writes nothing", async () => {
			const session = backend().session()
			await push.record(session, ALICE, id(1), keys('alice'), null, NOW)
			expect(await push.record(session, BOB, id(2), keys('bob'), endpoint('alice'), NOW)).toBe('not_replaceable')
			expect(await push.record(session, BOB, id(3), keys('bob'), endpoint('nobody'), NOW)).toBe('not_replaceable')
			expect((await backend().rows()).map((row) => row['endpoint'])).toEqual([endpoint('alice')])
		})

		test("a gone endpoint leaves a tombstone, which answers only its own principal's replacement, for 30 days", async () => {
			const session = backend().session()
			await push.record(session, ALICE, id(1), keys('gone'), null, NOW)
			expect(await push.retire(session, endpoint('gone'), NOW)).toBe(true)
			expect(await push.retire(session, endpoint('gone'), NOW)).toBe(false)
			expect(await backend().rows()).toMatchObject([{ principal: ALICE, p256dh: null, auth: null, vapid_key: null }])
			// A tombstone is no subscription of anyone's.
			expect(await push.binding(session, ALICE, endpoint('gone'))).toBe('unknown')
			// Another principal neither replaces it nor records its endpoint while it answers.
			expect(await push.record(session, BOB, id(2), keys('bob'), endpoint('gone'), NOW + 1)).toBe('not_replaceable')
			expect(await push.record(session, BOB, id(3), keys('gone'), null, NOW + 1)).toBe('taken')
			expect(await push.record(session, ALICE, id(4), keys('next'), endpoint('gone'), NOW + DAY)).toBe('recorded')
			expect(await backend().rows()).toMatchObject([{ id: id(4), endpoint: endpoint('next'), principal: ALICE }])
		})

		test('a tombstone past the retention answers no replacement, is pruned, and its endpoint may be recorded again', async () => {
			const session = backend().session()
			await push.record(session, ALICE, id(1), keys('gone'), null, NOW)
			await push.retire(session, endpoint('gone'), NOW)
			const later = NOW + PUSH_SUBSCRIPTION_LIMITS.tombstoneRetentionMs + 1
			expect(await push.record(session, ALICE, id(2), keys('next'), endpoint('gone'), later)).toBe('not_replaceable')
			expect((await backend().rows()).length).toBe(0)
			await push.record(session, ALICE, id(3), keys('old'), null, NOW)
			await push.retire(session, endpoint('old'), NOW)
			// Negative control: one day short of the retention it still answers.
			expect(await push.record(session, ALICE, id(4), keys('new'), endpoint('old'), later - DAY)).toBe('recorded')
		})

		test('a replacement refused after its old row went leaves the old row when the caller rolls back', async () => {
			await push.record(backend().session(), ALICE, id(1), keys('old'), null, NOW)
			await push.record(backend().session(), BOB, id(2), keys('bob'), null, NOW)
			const refused = new Error('not recorded')
			await expect(
				backend().session().transaction(async (session) => {
					// The new endpoint is Bob's, so the upsert refuses after the old row's delete.
					const outcome = await push.record(session, ALICE, id(3), keys('bob'), endpoint('old'), NOW + 1)
					expect(outcome).toBe('taken')
					throw refused
				}),
			).rejects.toBe(refused)
			expect(await push.binding(backend().session(), ALICE, endpoint('old'))).toBe('mine')
		})

		test("a principal keeps its ten newest subscriptions; another principal's are not counted", async () => {
			const session = backend().session()
			await push.record(session, BOB, id(100), keys('bob'), null, NOW)
			for (let n = 0; n < 11; n++) {
				expect(await push.record(session, ALICE, id(n), keys(`e${n}`), null, NOW + n)).toBe('recorded')
			}
			const alice = await backend().rows(`principal = '${ALICE}'`)
			expect(alice.length).toBe(PUSH_SUBSCRIPTION_LIMITS.perPrincipal)
			expect(alice.map((row) => row['endpoint'])).not.toContain(endpoint('e0'))
			expect(await push.binding(session, BOB, endpoint('bob'))).toBe('mine')
		})

		test("a removal reaches only the caller's own row", async () => {
			const session = backend().session()
			await push.record(session, ALICE, id(1), keys('e1'), null, NOW)
			expect(await push.remove(session, BOB, endpoint('e1'))).toBe(false)
			expect(await push.binding(session, ALICE, endpoint('e1'))).toBe('mine')
			expect(await push.remove(session, ALICE, endpoint('e1'))).toBe(true)
			expect(await push.remove(session, ALICE, endpoint('e1'))).toBe(false)
			expect((await backend().rows()).length).toBe(0)
		})
	})
}

// ── SQLite ─────────────────────────────────────────────────────────────────────────────────────────────────────────

let sqlite: Awaited<ReturnType<typeof sqliteFramework>>

describe('SQLite', () => {
	beforeEach(async () => {
		sqlite = await sqliteFramework()
	})
	suite('SQLite', () => ({
		session: () => sessionOf({ database: sqlite.database }),
		rows: async (where = 'true') => sqlite.exec(`select * from ${PUSH_SUBSCRIPTIONS_TABLE} where ${where} order by endpoint`),
		exec: async (statement) => {
			sqlite.exec(statement)
		},
	}), false)
})

// ── Postgres ───────────────────────────────────────────────────────────────────────────────────────────────────────

const schema = `ps_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
let postgres: Database

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

describe('Postgres', () => {
	beforeAll(async () => {
		if (!hasPostgres) return
		const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
		await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework}`))
		postgres = openPostgres({ url, schema, max: 4 })
	})
	beforeEach(async () => {
		if (!hasPostgres) return
		await admin((sql) => sql.unsafe(`delete from ${schema}.${PUSH_SUBSCRIPTIONS_TABLE}`))
	})
	afterAll(async () => {
		if (!hasPostgres) return
		await postgres.close()
		await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
	})
	suite('Postgres', () => ({
		session: () => sessionOf({ database: postgres }),
		rows: (where = 'true') =>
			admin(async (sql) => {
				const rows: Record<string, unknown>[] = await sql.unsafe(
					`select id::text as id, principal, endpoint, p256dh, auth, vapid_key, cursor from ${schema}.${PUSH_SUBSCRIPTIONS_TABLE} where ${where} order by endpoint`,
				)
				// Bun.SQL answers an array with fields of its own (count, command); compare plain rows.
				return rows.map((row) => ({ ...row }))
			}),
		exec: async (statement) => {
			await admin((sql) => sql.unsafe(`set search_path to ${schema}; ${statement}`))
		},
	}), !hasPostgres)

	test.skipIf(!hasPostgres)('of two principals recording one endpoint at once, exactly one is bound to it', async () => {
		const outcomes = await Promise.all([
			sessionOf({ database: postgres }).transaction((session) => push.record(session, ALICE, id(1), keys('shared'), null, NOW)),
			sessionOf({ database: postgres }).transaction((session) => push.record(session, BOB, id(2), keys('shared'), null, NOW)),
		])
		expect([...outcomes].sort()).toEqual(['recorded', 'taken'])
	})
})
