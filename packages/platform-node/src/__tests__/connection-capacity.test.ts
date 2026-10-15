// Waiting out a database at its connection limit. The refusal is the server's own (a role at its CONNECTION LIMIT
// answers SQLSTATE 53300, as a full server does), so this needs FABRIKA_TEST_POSTGRES_URL (a superuser) and skips
// cleanly without it; the clock and the sleep are the test's.

import { SQL } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ConnectionCapacityError, isConnectionCapacityError, withConnectionCapacity } from '../connection-capacity'

const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) console.warn('connection-capacity.test.ts skipped: set FABRIKA_TEST_POSTGRES_URL to run the Postgres-backed tests')

describe.skipIf(!hasPostgres)('a database at its connection limit', () => {
	const role = `fabrika_full_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
	let refused: unknown

	beforeAll(async () => {
		const admin = new SQL({ url, adapter: 'postgres', max: 1 })
		await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'full' CONNECTION LIMIT 0`)
		await admin.close()
		const limited = new URL(url)
		limited.username = role
		limited.password = 'full'
		const sql = new SQL({ url: limited.toString(), adapter: 'postgres', max: 1 })
		refused = await sql`SELECT 1`.then(() => undefined, (error: unknown) => error)
		await sql.close()
	})

	afterAll(async () => {
		const admin = new SQL({ url, adapter: 'postgres', max: 1 })
		await admin.unsafe(`DROP ROLE IF EXISTS ${role}`)
		await admin.close()
	})

	/** A clock that moves only when the waiting sleeps, and the delays it slept. */
	const clock = () => {
		let now = 0
		const slept: number[] = []
		return {
			slept,
			options: {
				now: () => now,
				random: () => 1,
				sleep: async (ms: number) => {
					slept.push(ms)
					now += ms
				},
			},
		}
	}

	test('refuses a connection with SQLSTATE 53300, which is the one error waited out', () => {
		expect(isConnectionCapacityError(refused)).toBe(true)
		expect(isConnectionCapacityError(new Error('too many clients already'))).toBe(false)
	})

	test('is retried with a growing delay until a slot is free', async () => {
		const { slept, options } = clock()
		let tries = 0
		const answer = await withConnectionCapacity(async () => {
			tries++
			if (tries < 4) throw refused
			return 'connected'
		}, { ...options, waitMs: 60_000 })
		expect(answer).toBe('connected')
		expect(slept).toEqual([250, 500, 1000])
	})

	test('fails saying the database had no free slot once the wait ran out, never past it', async () => {
		const { slept, options } = clock()
		const failure = await withConnectionCapacity(() => Promise.reject(refused), { ...options, waitMs: 2000 }).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(ConnectionCapacityError)
		expect(failure instanceof Error ? failure.message : '').toBe(
			'the database had no free connection slot for 2 s (SQLSTATE 53300): its connection limit is exhausted',
		)
		expect(slept).toEqual([250, 500, 1000, 250])
	})

	test('does not wait out any other failure', async () => {
		const { slept, options } = clock()
		const other = new Error('password authentication failed')
		expect(await withConnectionCapacity(() => Promise.reject(other), options).catch((error: unknown) => error)).toBe(other)
		expect(slept).toEqual([])
	})
})
