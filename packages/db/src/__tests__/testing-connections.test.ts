// The connections of `@fabrika/db/testing`: a test database opens all of them before its first case and ends all of them
// on close, and one that finds the database at its connection limit waits for a slot, then fails saying so. The limit is
// a throwaway database's CONNECTION LIMIT, which refuses every role but a superuser with SQLSTATE 53300, as a full
// server does. Needs FABRIKA_TEST_POSTGRES_URL (a superuser) and skips cleanly without it; no assertion prints the URL.

import { CONNECTION_CAPACITY_MESSAGE } from '@fabrika/platform-node'
import { SQL } from 'bun'
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { TEST_DATABASE_CONNECTIONS, testDatabase } from '../testing'
import { migration } from './fixtures/schema'
import { tables } from './fixtures/tables'

// A child process migrates its own schema and waits for a slot: under a loaded host that outlasts the 5 s default.
setDefaultTimeout(30_000)

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) console.warn(`testing-connections.test.ts skipped: set ${URL_VAR} to run the Postgres-backed tests`)

const migrations = mkdtempSync(join(tmpdir(), 'fabrika-db-connections-'))
writeFileSync(join(migrations, '20261009120000_init.sql'), migration)

const cleanups: (() => Promise<void>)[] = []
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup()
	rmSync(migrations, { recursive: true, force: true })
})

const countRows = z.array(z.object({ count: z.number() }))

/** The open connections of the migration and the runtime role of `schema`, read as the superuser. */
async function connectionsOf(schema: string): Promise<number> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		const roles = [schema, `run_${schema.slice('app_'.length)}`]
		const rows = countRows.parse(await sql.unsafe('SELECT count(*)::int AS count FROM pg_stat_activity WHERE usename IN ($1, $2)', roles))
		return rows[0]?.count ?? 0
	} finally {
		await sql.close()
	}
}

/** A throwaway database that admits at most `limit` connections of roles that are not superusers, and its URL. */
async function limitedDatabase(limit: number): Promise<{ readonly name: string; readonly url: string }> {
	const name = `fabrika_limited_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
	const admin = new SQL({ url, adapter: 'postgres', max: 1 })
	await admin.unsafe(`CREATE DATABASE ${name} CONNECTION LIMIT ${limit}`)
	await admin.close()
	cleanups.push(async () => {
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		await sql.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
		await sql.close()
	})
	const limited = new URL(url)
	limited.pathname = `/${name}`
	return { name, url: limited.toString() }
}

/** Runs `lines` as a Bun program in a child process, so a test database's process-wide state stays there. */
async function inChild(lines: readonly string[], databaseUrl: string): Promise<{ readonly stdout: string; readonly stderr: string }> {
	const child = Bun.spawn(['bun', '-e', lines.join('\n')], {
		cwd: join(import.meta.dir, '..', '..'),
		env: { PATH: process.env['PATH'] ?? '', [URL_VAR]: databaseUrl },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
	return { stdout, stderr }
}

describe.skipIf(!hasPostgres)("a test database's connections", () => {
	test('are open before the first case, are at most TEST_DATABASE_CONNECTIONS, and all end on close', async () => {
		const opened = await testDatabase({ migrations, label: 'connections.test.ts' })
		if (opened === null) throw new Error('a test database was expected')
		// The seeder and at least the runtime role's first, before anything was asked of them. The provisioning
		// connection is the superuser's here, so the roles of the schema hold one fewer than the total.
		expect(await connectionsOf(opened.schema)).toBeGreaterThanOrEqual(2)
		await opened.seedWorlds(tables, 'notes')
		expect(await connectionsOf(opened.schema)).toBeLessThanOrEqual(TEST_DATABASE_CONNECTIONS - 1)
		await opened.close()
		expect(await connectionsOf(opened.schema)).toBe(0)
	})

	test('wait for a slot while the database is at its limit, and open once one is free', async () => {
		// The runtime role's three connections fit, but not while three other connections hold every slot.
		const limited = await limitedDatabase(3)
		const holder = `fabrika_holder_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
		const admin = new SQL({ url, adapter: 'postgres', max: 1 })
		await admin.unsafe(`CREATE ROLE ${holder} LOGIN PASSWORD 'holder'`)
		await admin.close()
		cleanups.push(async () => {
			const sql = new SQL({ url, adapter: 'postgres', max: 1 })
			await sql.unsafe(`DROP ROLE IF EXISTS ${holder}`)
			await sql.close()
		})
		const holderUrl = new URL(limited.url)
		holderUrl.username = holder
		holderUrl.password = 'holder'
		const held = new SQL({ url: holderUrl.toString(), adapter: 'postgres', max: 3 })
		await Promise.all([1, 2, 3].map(() => held`SELECT pg_sleep(0.05)`))
		const started = performance.now()
		const child = inChild([
			"const { testDatabase } = await import('@fabrika/db/testing')",
			`const database = await testDatabase({ migrations: ${JSON.stringify(migrations)}, label: 'waiting.test.ts', connectionWaitMs: 30_000 })`,
			'await database?.close()',
			"console.log('opened')",
		], limited.url)
		await Bun.sleep(1500)
		await held.close()
		const { stdout, stderr } = await child
		expect({ stdout: stdout.trim(), stderr }).toEqual({ stdout: 'opened', stderr: '' })
		expect(performance.now() - started).toBeGreaterThanOrEqual(1500)
	})

	test('fail saying the database had no free slot once the wait ran out, and the next file of the run fails at once', async () => {
		const limited = await limitedDatabase(0)
		const { stdout, stderr } = await inChild([
			"const { testDatabase } = await import('@fabrika/db/testing')",
			`const options = { migrations: ${JSON.stringify(migrations)}, connectionWaitMs: 1000 }`,
			"for (const label of ['first.test.ts', 'second.test.ts']) {",
			'\tconst started = performance.now()',
			'\tconst message = await testDatabase({ ...options, label }).then(() => "opened", (error) => error.message)',
			'\tconsole.log(JSON.stringify({ message, ms: performance.now() - started }))',
			'}',
		], limited.url)
		expect(stderr).toBe('')
		const [first, second] = stdout.trim().split('\n').map((line) => z.object({ message: z.string(), ms: z.number() }).parse(JSON.parse(line)))
		expect(first?.message).toStartWith(`first.test.ts: ${CONNECTION_CAPACITY_MESSAGE} for 1 s (SQLSTATE 53300)`)
		expect(first?.message).toEndWith('its cases did not run')
		expect(first?.ms).toBeGreaterThanOrEqual(1000)
		expect(second?.message).toStartWith(`second.test.ts: ${CONNECTION_CAPACITY_MESSAGE}`)
		expect(second?.ms).toBeLessThan(500)
	})
})
