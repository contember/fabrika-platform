// The receipts of keyed mutations (ADR-0078) on both dialects: a receipt is found by its principal and key only; a key
// already recorded is not recorded again, also by a concurrent transaction; and each write prunes a bounded batch of
// receipts past the retention, never one inside it nor the key it writes. SQLite always runs (a bun:sqlite stand-in for
// a Durable Object's storage); Postgres skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { openPostgres } from '@fabrika/db/postgres'
import { applicationRuntimeUrl, definePostgresApplicationMigrations, dropApplicationDatabase } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { type Database, type Session, sessionOf } from '../database'
import { FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS, REQUEST_RECEIPTS_TABLE } from '../migrations'
import { type RequestReceipt, requestReceipts } from '../request-receipts'
import { sqliteFramework } from './fixtures/sqlite-framework'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''

if (!hasPostgres) {
	console.warn(`request-receipts.test.ts: the Postgres half skipped: set ${URL_VAR} to run it`)
}

const receipts = requestReceipts()
const NOW = 1_800_000_000_000
const RETAINED_SINCE = NOW - 7 * 24 * 60 * 60 * 1_000
const receipt = (output = '{"result":{"id":"a"}}'): RequestReceipt => ({ operation: 'api.entries.record', identity: 'f'.repeat(64), output })

/** What one dialect's half needs: a session, and the count of receipts by a condition, read past the data layer. */
interface Backend {
	session(): Session
	count(where?: string): Promise<number>
}

function suite(name: string, backend: () => Backend, skip: boolean): void {
	describe.skipIf(skip)(`request receipts on ${name}`, () => {
		test('a receipt is found by its principal and key only', async () => {
			const session = backend().session()
			expect(await receipts.find(session, 'user:alice', 'k1')).toBeNull()
			expect(await receipts.record(session, 'user:alice', 'k1', receipt(), NOW, RETAINED_SINCE)).toBe(true)
			expect(await receipts.find(session, 'user:alice', 'k1')).toEqual(receipt())
			expect(await receipts.find(session, 'user:bob', 'k1')).toBeNull()
			expect(await receipts.find(session, 'user:alice', 'k2')).toBeNull()
		})

		test('a key already recorded is not recorded again, and keeps its first receipt', async () => {
			const session = backend().session()
			expect(await receipts.record(session, 'user:alice', 'k1', receipt('{"result":1}'), NOW, RETAINED_SINCE)).toBe(true)
			expect(await receipts.record(session, 'user:alice', 'k1', receipt('{"result":2}'), NOW, RETAINED_SINCE)).toBe(false)
			expect((await receipts.find(session, 'user:alice', 'k1'))?.output).toBe('{"result":1}')
			// Negative control: another principal's same key is its own receipt.
			expect(await receipts.record(session, 'user:bob', 'k1', receipt('{"result":3}'), NOW, RETAINED_SINCE)).toBe(true)
		})

		test('a write prunes a bounded batch of receipts past the retention, and keeps those inside it', async () => {
			const session = backend().session()
			for (let i = 0; i < 40; i++) {
				await receipts.record(session, 'user:old', `old-${i}`, receipt(), RETAINED_SINCE - 1 - i, RETAINED_SINCE - 1_000_000)
			}
			await receipts.record(session, 'user:kept', 'kept', receipt(), RETAINED_SINCE, RETAINED_SINCE - 1_000_000)
			expect(await backend().count()).toBe(41)
			await receipts.record(session, 'user:alice', 'new-1', receipt(), NOW, RETAINED_SINCE)
			expect(await backend().count(`created_at < ${RETAINED_SINCE}`)).toBe(8)
			await receipts.record(session, 'user:alice', 'new-2', receipt(), NOW, RETAINED_SINCE)
			expect(await backend().count(`created_at < ${RETAINED_SINCE}`)).toBe(0)
			// The receipt exactly at the boundary is inside the retention.
			expect(await receipts.find(session, 'user:kept', 'kept')).not.toBeNull()
			expect(await backend().count()).toBe(3)
		})

		test('a prune never removes the key its own write records', async () => {
			const session = backend().session()
			await receipts.record(session, 'user:alice', 'k1', receipt(), RETAINED_SINCE - 10, RETAINED_SINCE - 1_000_000)
			// The old receipt of the same key stays, so the write finds it taken instead of replacing it.
			expect(await receipts.record(session, 'user:alice', 'k1', receipt('{"result":2}'), NOW, RETAINED_SINCE)).toBe(false)
			expect((await receipts.find(session, 'user:alice', 'k1'))?.output).toBe(receipt().output)
		})

		test('a receipt written in a transaction that rolls back is not kept', async () => {
			const refused = new Error('the work failed after its receipt')
			await expect(
				backend().session().transaction(async (session) => {
					await receipts.record(session, 'user:alice', 'k1', receipt(), NOW, RETAINED_SINCE)
					throw refused
				}),
			).rejects.toBe(refused)
			expect(await receipts.find(backend().session(), 'user:alice', 'k1')).toBeNull()
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
		count: async (where = 'true') => Number(sqlite.exec(`select count(*) as n from ${REQUEST_RECEIPTS_TABLE} where ${where}`)[0]?.['n']),
	}), false)
})

// ── Postgres ───────────────────────────────────────────────────────────────────────────────────────────────────────

const schema = `rr_${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
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
		await admin((sql) => sql.unsafe(`delete from ${schema}.${REQUEST_RECEIPTS_TABLE}`))
	})
	afterAll(async () => {
		if (!hasPostgres) return
		await postgres.close()
		await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
	})
	suite('Postgres', () => ({
		session: () => sessionOf({ database: postgres }),
		count: async (where = 'true') => {
			const [row] = await admin((sql) => sql.unsafe(`select count(*)::int as n from ${schema}.${REQUEST_RECEIPTS_TABLE} where ${where}`))
			return Number(row?.n)
		},
	}), !hasPostgres)

	test.skipIf(!hasPostgres)('of two concurrent transactions that record one key, the later one records nothing', async () => {
		const first = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const holding = sessionOf({ database: postgres }).transaction(async (session) => {
			const written = await receipts.record(session, 'user:alice', 'k1', receipt('{"result":1}'), NOW, RETAINED_SINCE)
			first.resolve()
			await release.promise
			return written
		})
		await first.promise
		const second = sessionOf({ database: postgres }).transaction((session) =>
			receipts.record(session, 'user:alice', 'k1', receipt('{"result":2}'), NOW, RETAINED_SINCE)
		)
		// The second waits for the first's commit, then finds the key taken.
		release.resolve()
		expect(await holding).toBe(true)
		expect(await second).toBe(false)
		expect((await receipts.find(sessionOf({ database: postgres }), 'user:alice', 'k1'))?.output).toBe('{"result":1}')
	})

	test.skipIf(!hasPostgres)('an existing schema applies 0011 alone on its next migrate, and the runtime role reads and writes receipts', async () => {
		const appId = `receipts-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`
		const earlier = FRAMEWORK_MIGRATIONS.filter((file) => file.name < '0011_request_receipts.sql')
		const migrationsOf = (framework: typeof FRAMEWORK_MIGRATIONS) =>
			definePostgresApplicationMigrations({ appId, directory: '/nonexistent', framework: { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: framework } })
		try {
			const app = [{ name: '20261121120000_init.sql', sql: 'CREATE TABLE notes (id TEXT PRIMARY KEY)' }]
			expect(await migrationsOf(earlier).migrate(url, app)).toEqual([...earlier.map((file) => `fabrika/${file.name}`), `app/${app[0]?.name}`])
			const after = migrationsOf(FRAMEWORK_MIGRATIONS.filter((file) => file.name <= '0011_request_receipts.sql'))
			expect(await after.migrate(url, app)).toEqual(['fabrika/0011_request_receipts.sql'])
			const runtime = openPostgres({ url: applicationRuntimeUrl(url, appId), schema: after.schema, max: 1 })
			try {
				const session = sessionOf({ database: runtime })
				expect(await receipts.record(session, 'user:alice', 'k1', receipt(), NOW, RETAINED_SINCE)).toBe(true)
				expect(await receipts.find(session, 'user:alice', 'k1')).toEqual(receipt())
			} finally {
				await runtime.close()
			}
		} finally {
			await dropApplicationDatabase(url, appId)
		}
	})
})
