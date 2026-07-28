// The dialect-free half of the lock's contract: what `SqlDeployLocks` puts ON THE WIRE, asserted with
// a recording stub rather than a database. The behavioural half needs a real engine and is pinned per
// dialect where that engine exists — @fabrika/control (SQLite/D1) and @fabrika/platform-node
// (Postgres). Both run the SAME implementation, which is why it lives here.

import { describe, expect, test } from 'bun:test'
import { SqlDeployLocks } from '../deploy-locks-sql'
import type { SqlDatabase, SqlQueryResult, SqlRunResult, SqlStatement } from '../sql'

interface Issued {
	sql: string
	values: unknown[]
}

/** A stub database that records every statement + its bound values and reports `changes` on demand. */
function recorder(changes = 1): { db: SqlDatabase; issued: Issued[] } {
	const issued: Issued[] = []
	const db: SqlDatabase = {
		prepare(sql: string): SqlStatement {
			const entry: Issued = { sql, values: [] }
			issued.push(entry)
			const statement: SqlStatement = {
				bind(...values: unknown[]): SqlStatement {
					entry.values = values
					return statement
				},
				first: () => Promise.resolve(null),
				all: <T = Record<string, unknown>>(): Promise<SqlQueryResult<T>> => Promise.resolve({ results: [] }),
				run: (): Promise<SqlRunResult> => Promise.resolve({ meta: { changes } }),
			}
			return statement
		},
		batch: () => Promise.resolve([]),
	}
	return { db, issued }
}

describe('acquire — the statement', () => {
	test('is ONE conditional upsert, never a read followed by a write (that is the race it prevents)', async () => {
		const { db, issued } = recorder()
		await new SqlDeployLocks(db).acquire('app:prod', 'run-1', 60_000)

		expect(issued).toHaveLength(1)
		expect(issued[0]?.sql).toContain('INSERT INTO deploy_locks')
		expect(issued[0]?.sql).toContain('ON CONFLICT')
		// The takeover condition lives INSIDE the statement, not in TypeScript.
		expect(issued[0]?.sql).toContain('deploy_locks.expires_at <= ?')
	})

	test('binds the lease deadline and the current instant from the injected clock', async () => {
		const { db, issued } = recorder()
		await new SqlDeployLocks(db, { now: () => 1_700_000_000_000 }).acquire('app:prod', 'run-1', 5_000)

		expect(issued[0]?.values).toEqual(['app:prod', 'run-1', 1_700_000_005_000, 1_700_000_000_000])
	})

	test('`meta.changes` is the whole answer — 1 means the lease is ours, 0 means someone holds it', async () => {
		expect(await new SqlDeployLocks(recorder(1).db).acquire('app:prod', 'run-1', 60_000)).toBe(true)
		expect(await new SqlDeployLocks(recorder(0).db).acquire('app:prod', 'run-1', 60_000)).toBe(false)
	})
})

describe('release — the statement', () => {
	test('is a holder-checked delete, so a superseded run cannot free a newer holder"s lease', async () => {
		const { db, issued } = recorder()
		await new SqlDeployLocks(db).release('app:prod', 'run-1')

		expect(issued).toHaveLength(1)
		expect(issued[0]?.sql).toBe('DELETE FROM deploy_locks WHERE lock_key = ? AND holder = ?')
		expect(issued[0]?.values).toEqual(['app:prod', 'run-1'])
	})
})

describe('the lease table is a parameter', () => {
	test('a custom table is used by both statements, so two lease namespaces can coexist', async () => {
		const { db, issued } = recorder()
		const locks = new SqlDeployLocks(db, { table: 'other_locks' })
		await locks.acquire('app:prod', 'run-1', 60_000)
		await locks.release('app:prod', 'run-1')

		expect(issued[0]?.sql).toContain('INSERT INTO other_locks')
		expect(issued[0]?.sql).toContain('other_locks.expires_at <= ?')
		expect(issued[1]?.sql).toContain('DELETE FROM other_locks')
	})

	test('rejects anything that is not a bare identifier — the name is interpolated into SQL', () => {
		const { db } = recorder()
		for (const table of ['deploy locks', 'locks; DROP TABLE runs', 'public.locks', '1locks', '']) {
			expect(() => new SqlDeployLocks(db, { table })).toThrow('invalid lock table name')
		}
		expect(() => new SqlDeployLocks(db, { table: 'deploy_locks_2' })).not.toThrow()
	})
})
