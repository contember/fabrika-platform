// The light tier's load-bearing assumption, pinned.
//
// `platformTopology({ tier: 'light' })` puts IAM, control, Operations AND the apps deployed alongside
// them in ONE `postgresql:single@18`. On Zerops that means one database and one `public` schema —
// `${db_connectionString}` carries no `search_path`, and nothing sets one. So the three services'
// schemas are not merely adjacent, they are INTERLEAVED, and the tier is only correct while:
//
//   1. their table names stay disjoint, except for the one table designed to be shared;
//   2. the shared `jobs` table is declared identically on both sides that create it, so whichever
//      migrates first wins and the other's `CREATE TABLE IF NOT EXISTS` is a genuine no-op;
//   3. the two job consumers filter on DIFFERENT queue names, because they now poll the same rows;
//   4. each service keeps its own migration ledger and advisory lock (ADR-0017).
//
// None of that is checked anywhere else. The package's Postgres suites give each test FILE its own
// schema (`platform-node`'s helper creates one and sets `search_path`), which is right for those tests
// and is exactly why they cannot catch a collision between two services.
//
// Deliberately a text-level test over the migration files rather than an integration test: this package
// does not depend on `@fabrika/iam`, `@fabrika/control` or `@fabrika/operations`, and adding three
// dependencies to assert a naming property would be a heavier coupling than the property is worth.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../artifacts'

/** The table this tier knowingly shares — `PostgresJobQueue` multiplexes queues by the `queue` column. */
const SHARED_TABLE = 'jobs'

const CREATE_TABLE = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g

const tablesIn = (directory: string): string[] => {
	const dir = join(REPO_ROOT, directory)
	const sql = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()
		.map((name) => readFileSync(join(dir, name), 'utf8')).join('\n')
	return [...sql.matchAll(CREATE_TABLE)].map((match) => match[1] ?? '')
}

const SERVICES = {
	iam: 'packages/iam/migrations-postgres',
	control: 'packages/control/migrations-postgres',
	operations: 'packages/operations/migrations-postgres',
} as const

describe('the light tier shares one database, so the three schemas must interleave safely', () => {
	test('every service actually declares tables — a silent empty read would make this file vacuous', () => {
		for (const [service, directory] of Object.entries(SERVICES)) {
			expect(tablesIn(directory).length, `${service} declares no tables`).toBeGreaterThan(0)
		}
	})

	test('no two services declare the same table, apart from the one they are meant to share', () => {
		const entries = Object.entries(SERVICES).map(([service, directory]) => [service, new Set(tablesIn(directory))] as const)
		for (const [serviceA, tablesA] of entries) {
			for (const [serviceB, tablesB] of entries) {
				if (serviceA >= serviceB) continue
				const shared = [...tablesA].filter((table) => tablesB.has(table) && table !== SHARED_TABLE)
				expect(shared, `${serviceA} and ${serviceB} would collide in a shared schema`).toEqual([])
			}
		}
	})

	test('the two `jobs` declarations are column-for-column identical, so whoever migrates first wins', () => {
		// `@fabrika/platform-node` owns the reference DDL and Operations composes that bundle; control
		// restates it because DDL is per-service. Restating it is only safe while the two agree.
		const columns = (path: string): string => {
			// Comments come off FIRST: `-- UUIDv7, minted caller-side (time-ordered)` closes a paren the
			// table body never opened, and a naive `\(([^)]*)\)` truncates after the first column.
			const sql = readFileSync(join(REPO_ROOT, path), 'utf8')
				.split('\n').map((line) => line.replace(/--.*$/, '').trimEnd()).join('\n')
			const body = /CREATE TABLE IF NOT EXISTS jobs \(([^)]*)\)/.exec(sql)?.[1]
			if (body === undefined) throw new Error(`no jobs table in ${path}`)
			return body.split('\n').map((line) => line.trim()).filter((line) => line !== '').join(' ')
		}
		const reference = columns('packages/platform-node/migrations/0001_jobs.sql')
		expect(columns('packages/control/migrations-postgres/0002_jobs.sql')).toBe(reference)
		// Guard the guard: if the extraction ever silently returns a fragment, these two make it fail
		// rather than compare two equal fragments.
		expect(reference).toContain('queue')
		expect(reference).toContain('max_attempts INTEGER NOT NULL')
	})

	test('both `jobs` creators are idempotent — the second service must not fail on an existing table', () => {
		for (const path of ['packages/platform-node/migrations/0001_jobs.sql', 'packages/control/migrations-postgres/0002_jobs.sql']) {
			const sql = readFileSync(join(REPO_ROOT, path), 'utf8')
			expect(sql, path).toContain('CREATE TABLE IF NOT EXISTS jobs')
			expect(sql, path).toContain('CREATE INDEX IF NOT EXISTS idx_jobs_due')
		}
	})

	test('the two consumers poll DIFFERENT queue names, which is what makes one table correct', () => {
		const read = (path: string): string => readFileSync(join(REPO_ROOT, path), 'utf8')
		expect(read('packages/control/src/node/runtime.ts')).toContain(`DEPLOY_QUEUE_NAME = 'vozka-deploy'`)
		expect(read('packages/operations/src/node/consumer.ts')).toContain(`OPERATIONS_INGEST_QUEUE = 'operations-ingest'`)
	})

	test('each service owns a distinct migration ledger and advisory lock (ADR-0017)', () => {
		const migrate = (service: string): string => readFileSync(join(REPO_ROOT, `packages/${service}/src/node/migrate.ts`), 'utf8')
		const field = (source: string, name: string): string => {
			const value = new RegExp(`${name}:\\s*'([^']+)'`).exec(source)?.[1]
			if (value === undefined) throw new Error(`no ${name}`)
			return value
		}
		const lock = (source: string): string => {
			const value = /MIGRATION_LOCK_KEY = (\d+)/.exec(source)?.[1]
			if (value === undefined) throw new Error('no MIGRATION_LOCK_KEY')
			return value
		}
		const sources = ['iam', 'control', 'operations'].map(migrate)
		const ledgers = sources.map((source) => field(source, 'ledgerTable'))
		const locks = sources.map(lock)
		expect(ledgers).toEqual(['iam_schema_migrations', 'control_schema_migrations', 'operations_schema_migrations'])
		expect(new Set(locks).size).toBe(3)
	})
})
