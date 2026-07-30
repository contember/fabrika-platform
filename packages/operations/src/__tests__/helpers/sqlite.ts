import type { SqlDatabase, SqlQueryResult, SqlRunResult, SqlStatement } from '@fabrika/platform'
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSqliteOperationsRepositories, type OperationsRepositories } from '../../repositories.js'

function binding(value: unknown): SQLQueryBindings {
	if (
		value === null
		|| typeof value === 'string'
		|| typeof value === 'number'
		|| typeof value === 'bigint'
		|| typeof value === 'boolean'
	) return value
	if (value === undefined) return null
	throw new Error(`unsupported binding: ${typeof value}`)
}

function rows<T>(value: unknown): T[] {
	const decoded: { rows: T[] } = JSON.parse(JSON.stringify({ rows: value }))
	return decoded.rows
}

class Statement implements SqlStatement {
	private values: SQLQueryBindings[] = []

	constructor(private readonly sqlite: Database, private readonly sql: string) {}

	bind(...values: unknown[]): SqlStatement {
		const statement = new Statement(this.sqlite, this.sql)
		statement.values = values.map(binding)
		return statement
	}

	first<T = Record<string, unknown>>(): Promise<T | null> {
		const value = this.sqlite.query(this.sql).get(...this.values)
		if (value === null) return Promise.resolve(null)
		return Promise.resolve(rows<T>([value])[0] ?? null)
	}

	all<T = Record<string, unknown>>(): Promise<SqlQueryResult<T>> {
		return Promise.resolve({ results: rows<T>(this.sqlite.query(this.sql).all(...this.values)) })
	}

	run(): Promise<SqlRunResult> {
		const result = this.sqlite.query(this.sql).run(...this.values)
		return Promise.resolve({ meta: { changes: result.changes } })
	}
}

class TestDatabase implements SqlDatabase {
	constructor(private readonly sqlite: Database) {}

	prepare(sql: string): SqlStatement {
		return new Statement(this.sqlite, sql)
	}

	async batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlQueryResult<T>[]> {
		this.sqlite.run('BEGIN')
		try {
			const results: SqlQueryResult<T>[] = []
			for (const statement of statements) results.push(await statement.all<T>())
			this.sqlite.run('COMMIT')
			return results
		} catch (error) {
			this.sqlite.run('ROLLBACK')
			throw error
		}
	}
}

export interface OperationsHarness {
	sqlite: Database
	db: SqlDatabase
	repositories: OperationsRepositories
}

export function createHarness(now: () => number = Date.now): OperationsHarness {
	const sqlite = new Database(':memory:')
	sqlite.exec('PRAGMA foreign_keys = ON')
	const migrations = join(import.meta.dir, '..', '..', '..', 'migrations')
	for (const file of readdirSync(migrations).filter((entry) => entry.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(migrations, file), 'utf8'))
	}
	const db = new TestDatabase(sqlite)
	return { sqlite, db, repositories: createSqliteOperationsRepositories(db, { now }) }
}
