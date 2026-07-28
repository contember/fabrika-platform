// The lock's three guarantees are the reason a deploy of one target never runs twice. The
// implementation is portable (`@fabrika/platform`); what is asserted HERE is that it holds on a real
// POSTGRES — including the property that cannot be tested by calling the API in sequence: that a
// CONCURRENT race has exactly one winner, which is what makes the single conditional upsert (rather
// than a read-then-write) load-bearing. The SQLite/D1 side of the same contract is pinned in
// @fabrika/control's deploy-locks.test.ts, and the dialect-free shape in @fabrika/platform's own test.

import { type SqlDatabase, SqlDeployLocks } from '@fabrika/platform'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`deploy-locks-sql.test.ts ${skipReason}`)
}

const TTL_MS = 60_000

let fixture: PostgresFixture | null = null
let db: SqlDatabase

beforeAll(async () => {
	if (!hasPostgres) {
		return
	}
	fixture = await createPostgres('pglock')
	db = fixture.db
})

afterAll(async () => {
	await fixture?.close()
})

/** A lock with a clock the test drives, so expiry is provable without sleeping. */
function locksWithClock(clock: { now: number }): SqlDeployLocks {
	return new SqlDeployLocks(db, { now: () => clock.now })
}

async function clear(): Promise<void> {
	await db.prepare('DELETE FROM deploy_locks').run()
}

describe.skipIf(!hasPostgres)('SqlDeployLocks', () => {
	test('acquires a free lease', async () => {
		await clear()
		const locks = new SqlDeployLocks(db)
		expect(await locks.acquire('app:prod', 'run-1', TTL_MS)).toBe(true)
	})

	test('is NON-REENTRANT: a live lease is refused even to its own holder', async () => {
		await clear()
		const locks = new SqlDeployLocks(db)
		expect(await locks.acquire('app:prod', 'run-1', TTL_MS)).toBe(true)
		expect(await locks.acquire('app:prod', 'run-1', TTL_MS)).toBe(false)
		expect(await locks.acquire('app:prod', 'run-2', TTL_MS)).toBe(false)
	})

	test('different targets do not contend', async () => {
		await clear()
		const locks = new SqlDeployLocks(db)
		expect(await locks.acquire('app:prod', 'run-1', TTL_MS)).toBe(true)
		expect(await locks.acquire('app:stage', 'run-2', TTL_MS)).toBe(true)
		expect(await locks.acquire('other:prod', 'run-3', TTL_MS)).toBe(true)
	})

	test('is TTL-BOUNDED: an expired lease is taken over by the next run', async () => {
		await clear()
		const clock = { now: 1_000_000 }
		const locks = locksWithClock(clock)
		expect(await locks.acquire('app:prod', 'dead-run', 5_000)).toBe(true)
		clock.now += 4_999
		expect(await locks.acquire('app:prod', 'next-run', 5_000)).toBe(false)
		clock.now += 1
		expect(await locks.acquire('app:prod', 'next-run', 5_000)).toBe(true)
	})

	test('release frees the lease for the next run', async () => {
		await clear()
		const locks = new SqlDeployLocks(db)
		await locks.acquire('app:prod', 'run-1', TTL_MS)
		await locks.release('app:prod', 'run-1')
		expect(await locks.acquire('app:prod', 'run-2', TTL_MS)).toBe(true)
	})

	test('release is HOLDER-CHECKED: a superseded run cannot free the new holder"s lease', async () => {
		await clear()
		const clock = { now: 1_000_000 }
		const locks = locksWithClock(clock)
		await locks.acquire('app:prod', 'old-run', 5_000)
		clock.now += 5_000
		expect(await locks.acquire('app:prod', 'new-run', 5_000)).toBe(true)
		// The old run finally finishes and releases — it must NOT free the lease the new run holds.
		await locks.release('app:prod', 'old-run')
		expect(await locks.acquire('app:prod', 'third-run', 5_000)).toBe(false)
	})

	test('release is idempotent and a release of an unheld key is a no-op', async () => {
		await clear()
		const locks = new SqlDeployLocks(db)
		await locks.acquire('app:prod', 'run-1', TTL_MS)
		await locks.release('app:prod', 'run-1')
		await locks.release('app:prod', 'run-1')
		await locks.release('never:held', 'run-9')
		expect(await locks.acquire('app:prod', 'run-2', TTL_MS)).toBe(true)
	})

	test('a CONCURRENT race has exactly one winner', async () => {
		await clear()
		const locks = new SqlDeployLocks(db)
		const attempts = await Promise.all(
			Array.from({ length: 12 }, (_, i) => locks.acquire('app:prod', `run-${i}`, TTL_MS)),
		)
		expect(attempts.filter((won) => won)).toHaveLength(1)
	})

	test('a concurrent race for an EXPIRED lease also has exactly one winner', async () => {
		await clear()
		const clock = { now: 2_000_000 }
		const locks = locksWithClock(clock)
		await locks.acquire('app:prod', 'dead-run', 1_000)
		clock.now += 1_000
		const attempts = await Promise.all(
			Array.from({ length: 12 }, (_, i) => locks.acquire('app:prod', `run-${i}`, 1_000)),
		)
		expect(attempts.filter((won) => won)).toHaveLength(1)
	})

	test('is generic over the table name, so two lease namespaces can coexist', async () => {
		await db.prepare('CREATE TABLE IF NOT EXISTS other_locks (lock_key TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at BIGINT NOT NULL)').run()
		await db.prepare('DELETE FROM other_locks').run()
		await clear()
		const primary = new SqlDeployLocks(db)
		const secondary = new SqlDeployLocks(db, { table: 'other_locks' })
		expect(await primary.acquire('app:prod', 'run-1', TTL_MS)).toBe(true)
		expect(await secondary.acquire('app:prod', 'run-2', TTL_MS)).toBe(true)
		await secondary.release('app:prod', 'run-2')
		expect(await primary.acquire('app:prod', 'run-3', TTL_MS)).toBe(false)
	})
})
