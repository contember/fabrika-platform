import { type SqlDatabase, SqlDeployLocks, type SqlQueryResult, type SqlStatement } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { createHarness } from './helpers/harness'

// The per-app-env deploy lock (the portable `@fabrika/platform` implementation) against the REAL
// `deploy_locks` schema this Worker migrates — in-memory sqlite via the harness, which is the dialect
// D1 actually is. This is the one place fabrika serializes deploys of the same target, so the three
// contract properties it inherited from the DeployLock Durable Object are each pinned here:
//   * NON-REENTRANT   — a live lease is refused to everyone, including its own holder;
//   * TTL-BOUNDED     — an abandoned lease is taken over once its deadline passes (self-heal);
//   * HOLDER-CHECKED  — release only clears the lease the caller actually owns.
// Plus the property that motivates doing it in ONE statement: two consumers racing for a free target
// cannot both win.

const TTL_MS = 60_000

/** A lock over the harness DB with a test-controlled clock. Returns the clock so tests can advance it. */
function makeLocks(): { locks: SqlDeployLocks; advance: (ms: number) => void; prepared: string[] } {
	const { d1 } = createHarness()
	// The harness hands back a `D1Database`; the lock is written against the PORT, which D1 satisfies.
	const sql: SqlDatabase = d1
	const prepared: string[] = []
	let now = 1_700_000_000_000
	// Wrapping the handle (rather than counting rows) lets a test assert HOW MANY statements an
	// operation issues — the single-statement property is what makes acquire race-free.
	const recording: SqlDatabase = {
		prepare(statement: string): SqlStatement {
			prepared.push(statement)
			return sql.prepare(statement)
		},
		batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlQueryResult<T>[]> {
			return sql.batch<T>(statements)
		},
	}
	return {
		locks: new SqlDeployLocks(recording, { now: () => now }),
		advance: (ms) => {
			now += ms
		},
		prepared,
	}
}

describe('acquire — mutual exclusion', () => {
	test('the first caller takes the lease and every other caller is refused while it is live', async () => {
		const { locks } = makeLocks()

		expect(await locks.acquire('app:prod', 'run-1', TTL_MS)).toBe(true)
		expect(await locks.acquire('app:prod', 'run-2', TTL_MS)).toBe(false)
		expect(await locks.acquire('app:prod', 'run-3', TTL_MS)).toBe(false)
	})

	test('concurrent acquisition of a FREE key: exactly one caller wins', async () => {
		const { locks } = makeLocks()

		const results = await Promise.all(
			['run-1', 'run-2', 'run-3', 'run-4', 'run-5'].map((holder) => locks.acquire('app:prod', holder, TTL_MS)),
		)

		expect(results.filter((won) => won)).toHaveLength(1)
	})

	test('acquire is ONE statement — never a read followed by a write (that is the race it prevents)', async () => {
		const { locks, prepared } = makeLocks()

		await locks.acquire('app:prod', 'run-1', TTL_MS)

		expect(prepared).toHaveLength(1)
		// A conditional upsert: the takeover condition lives INSIDE the statement, not in TypeScript.
		expect(prepared[0]).toContain('ON CONFLICT')
		expect(prepared[0]).toContain('expires_at <= ?')
	})

	test('NON-REENTRANT: a live lease is refused even to the holder that owns it', async () => {
		const { locks } = makeLocks()

		expect(await locks.acquire('app:prod', 'run-1', TTL_MS)).toBe(true)
		// A redelivered queue message must DEFER, not double-run — same answer as for a stranger.
		expect(await locks.acquire('app:prod', 'run-1', TTL_MS)).toBe(false)
	})

	test('different app-envs are independent — one deploy never blocks another target', async () => {
		const { locks } = makeLocks()

		expect(await locks.acquire('app:prod', 'run-1', TTL_MS)).toBe(true)
		expect(await locks.acquire('app:stage', 'run-2', TTL_MS)).toBe(true)
		expect(await locks.acquire('other:prod', 'run-3', TTL_MS)).toBe(true)
	})
})

describe('acquire — TTL self-heal', () => {
	test('an abandoned lease (holder died, never released) is taken over once it expires', async () => {
		const { locks, advance } = makeLocks()
		expect(await locks.acquire('app:prod', 'run-1', TTL_MS)).toBe(true)

		// One millisecond short of the deadline the lease is still honored.
		advance(TTL_MS - 1)
		expect(await locks.acquire('app:prod', 'run-2', TTL_MS)).toBe(false)

		// At the deadline it is stale, and the next run takes the app-env over.
		advance(1)
		expect(await locks.acquire('app:prod', 'run-2', TTL_MS)).toBe(true)
	})

	test('a takeover starts a FRESH lease — the new holder is protected for its own full TTL', async () => {
		const { locks, advance } = makeLocks()
		await locks.acquire('app:prod', 'run-1', TTL_MS)
		advance(TTL_MS)
		expect(await locks.acquire('app:prod', 'run-2', TTL_MS)).toBe(true)

		advance(TTL_MS - 1)
		expect(await locks.acquire('app:prod', 'run-3', TTL_MS)).toBe(false)
	})
})

describe('release — holder-checked', () => {
	test('the owner frees the lease immediately, well before the TTL', async () => {
		const { locks } = makeLocks()
		await locks.acquire('app:prod', 'run-1', TTL_MS)

		await locks.release('app:prod', 'run-1')

		expect(await locks.acquire('app:prod', 'run-2', TTL_MS)).toBe(true)
	})

	test('a NON-owner cannot free a live lease', async () => {
		const { locks } = makeLocks()
		await locks.acquire('app:prod', 'run-1', TTL_MS)

		await locks.release('app:prod', 'run-2')

		expect(await locks.acquire('app:prod', 'run-3', TTL_MS)).toBe(false)
	})

	test("a SUPERSEDED holder's late release cannot free the lease a newer run has taken", async () => {
		const { locks, advance } = makeLocks()
		// run-1 stalls past its TTL; run-2 takes the app-env over.
		await locks.acquire('app:prod', 'run-1', TTL_MS)
		advance(TTL_MS)
		expect(await locks.acquire('app:prod', 'run-2', TTL_MS)).toBe(true)

		// run-1 finally reaches its `finally` and releases. It must NOT unlock run-2's deploy.
		await locks.release('app:prod', 'run-1')

		expect(await locks.acquire('app:prod', 'run-3', TTL_MS)).toBe(false)
		// …and run-2 still owns its lease, so its own release still works.
		await locks.release('app:prod', 'run-2')
		expect(await locks.acquire('app:prod', 'run-3', TTL_MS)).toBe(true)
	})

	test('release is idempotent — an unheld key and a second release are both no-ops', async () => {
		const { locks } = makeLocks()

		await locks.release('never:held', 'run-1')
		await locks.acquire('app:prod', 'run-1', TTL_MS)
		await locks.release('app:prod', 'run-1')
		await locks.release('app:prod', 'run-1')

		expect(await locks.acquire('app:prod', 'run-2', TTL_MS)).toBe(true)
	})
})
