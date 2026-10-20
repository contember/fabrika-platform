// The connections `fabrika db test-isolation` holds: its peak over the Zerops example, measured in a throwaway database
// of its own, and a run that finds the database at its CONNECTION LIMIT (SQLSTATE 53300, as a full server answers) and
// waits for a slot. Needs FABRIKA_TEST_POSTGRES_URL (a superuser) and skips cleanly without it; no assertion prints it.

import { TEST_DATABASE_CONNECTIONS } from '@fabrika/db/testing'
import { CONNECTION_CAPACITY_MESSAGE } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { reportsExhaustedConnections, runDbCommand } from '../db'

// A run migrates a schema per generated test file and waits for a slot: under a loaded host that outlasts the default.
setDefaultTimeout(60_000)

const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) console.warn('db-connections.test.ts skipped: set FABRIKA_TEST_POSTGRES_URL to run the Postgres-backed tests')

const EXAMPLE = join(import.meta.dir, '..', '..', '..', '..', 'examples', 'zerops-app')

const cleanups: (() => Promise<void>)[] = []
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup()
})

/** Runs `statement` as the superuser on a connection of its own. */
async function asSuperuser(statement: string): Promise<unknown> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await sql.unsafe(statement)
	} finally {
		await sql.close()
	}
}

/** A throwaway database, at most `limit` connections of roles that are not superusers when one is given, and its URL. */
async function throwawayDatabase(limit?: number): Promise<{ readonly name: string; readonly url: string }> {
	const name = `fabrika_cli_conn_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
	await asSuperuser(`CREATE DATABASE ${name}${limit === undefined ? '' : ` CONNECTION LIMIT ${limit}`}`)
	cleanups.push(async () => {
		await asSuperuser(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
	})
	const database = new URL(url)
	database.pathname = `/${name}`
	return { name, url: database.toString() }
}

const testIsolation = async (databaseUrl: string): Promise<string> => {
	const output: string[] = []
	await runDbCommand('test-isolation', [], {
		cwd: EXAMPLE,
		source: { FABRIKA_APP_DATABASE_URL: databaseUrl, PATH: process.env['PATH'] },
		now: () => new Date(),
		write: (line) => output.push(line),
	})
	return output.join('').replace(/^dropped the test provisioners earlier runs left behind: [^\n]*\n/, '')
}

const peakRows = z.array(z.object({ count: z.number() }))

describe('a run that met a database at its connection limit', () => {
	test("is recognised by the server's words or the test kit's, and nothing else", () => {
		expect(reportsExhaustedConnections(`notes.test.ts: ${CONNECTION_CAPACITY_MESSAGE} for 60 s (SQLSTATE 53300)`)).toBe(true)
		expect(reportsExhaustedConnections('PostgresError: remaining connection slots are reserved for roles with the SUPERUSER attribute')).toBe(true)
		expect(reportsExhaustedConnections('PostgresError: sorry, too many clients already')).toBe(true)
		expect(reportsExhaustedConnections('PostgresError: too many connections for role "run_test_0123456789abcdef"')).toBe(true)
		expect(reportsExhaustedConnections('(fail) notes > get of a row in another workspace is 404\nExpected: 404\nReceived: 200')).toBe(false)
	})
})

describe.skipIf(!hasPostgres)('fabrika db test-isolation against real Postgres', () => {
	test('holds at most TEST_DATABASE_CONNECTIONS connections of roles that are not superusers, and none after the run', async () => {
		const database = await throwawayDatabase()
		const sampler = new SQL({ url, adapter: 'postgres', max: 1 })
		let peak = 0
		let running = true
		const sampling = (async () => {
			while (running) {
				// A backend still authenticating has no role yet; it is counted once it has one.
				const rows = peakRows.parse(
					await sampler.unsafe(
						`SELECT count(*)::int AS count FROM pg_stat_activity a JOIN pg_roles r ON r.oid = a.usesysid
						WHERE a.datname = $1 AND a.backend_type = 'client backend' AND NOT r.rolsuper`,
						[database.name],
					),
				)
				peak = Math.max(peak, rows[0]?.count ?? 0)
				await Bun.sleep(2)
			}
		})()
		try {
			expect(await testIsolation(database.url)).toBe('49 generated cases passed\n')
		} finally {
			running = false
			await sampling
		}
		const left = peakRows.parse(
			await sampler.unsafe(`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend'`, [
				database.name,
			]),
		)
		await sampler.close()
		expect(peak).toBeGreaterThan(0)
		expect(peak).toBeLessThanOrEqual(TEST_DATABASE_CONNECTIONS)
		expect(left[0]?.count).toBe(0)
	})

	test('waits while other roles hold every slot, then passes', async () => {
		const database = await throwawayDatabase(TEST_DATABASE_CONNECTIONS)
		const holder = `fabrika_cli_holder_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
		await asSuperuser(`CREATE ROLE ${holder} LOGIN PASSWORD 'holder'`)
		cleanups.push(async () => {
			await asSuperuser(`DROP ROLE IF EXISTS ${holder}`)
		})
		const holderUrl = new URL(database.url)
		holderUrl.username = holder
		holderUrl.password = 'holder'
		const held = new SQL({ url: holderUrl.toString(), adapter: 'postgres', max: TEST_DATABASE_CONNECTIONS })
		await Promise.all(Array.from({ length: TEST_DATABASE_CONNECTIONS }, () => held`SELECT pg_sleep(0.05)`))
		const started = performance.now()
		const run = testIsolation(database.url)
		await Bun.sleep(3000)
		await held.close()
		expect(await run).toBe('49 generated cases passed\n')
		expect(performance.now() - started).toBeGreaterThanOrEqual(3000)
	})
})
