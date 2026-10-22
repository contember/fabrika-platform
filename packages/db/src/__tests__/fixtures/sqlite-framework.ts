// An application's SQLite database as its Durable Object boots it: a bun:sqlite stand-in for the object's storage, the
// framework bundle and the test's own `app` bundle applied by the real runner, and the data layer's engine over it.

import type { Database } from '../../database'
import { SQLITE_FRAMEWORK_MIGRATIONS } from '../../migrations-sqlite'
import { openSqlite, type SqliteValue } from '../../sqlite'
import { type BunSqliteStorage, bunSqliteStorage } from '../../sqlite-bun'
import { migrateSqlite } from '../../sqlite-migrate'

export interface SqliteFramework {
	readonly storage: BunSqliteStorage
	readonly database: Database
	/** Runs `query` on the storage itself, past the data layer: a test's own setup and inspection. */
	exec(query: string, ...bindings: SqliteValue[]): Record<string, SqliteValue>[]
}

/** A fresh in-memory database with the framework's tables and, when given, the tables `app` creates. */
export async function sqliteFramework(app?: string): Promise<SqliteFramework> {
	const storage = bunSqliteStorage()
	const bundles = [{ bundle: 'fabrika', migrations: SQLITE_FRAMEWORK_MIGRATIONS }]
	if (app !== undefined) {
		bundles.push({ bundle: 'app', migrations: [{ name: '0001_app.sql', sql: app }] })
	}
	await migrateSqlite({ exec: storage.sql.exec, transactionSync: (fn) => storage.transactionSync(fn) }, bundles)
	return {
		storage,
		database: openSqlite(storage),
		exec: (query, ...bindings) => storage.sql.exec(query, ...bindings).toArray(),
	}
}
