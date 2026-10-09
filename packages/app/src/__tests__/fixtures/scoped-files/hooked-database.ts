// A real Postgres connection for `boot` that runs a test's hook after each statement returns, so a test can move an
// owner between two statements of one request: after the access check located a file, before the final operation.

import { Database } from '@fabrika/db'
import { SQL } from 'bun'
import type { CompiledQuery, DatabaseConnection, Driver, QueryResult } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'

export type StatementHook = (sql: string) => Promise<void>

class HookedDialect extends PostgresJSDialect {
	readonly #after: StatementHook

	constructor(pool: SQL, after: StatementHook) {
		super({ postgres: pool })
		this.#after = after
	}

	override createDriver(): Driver {
		const driver = super.createDriver()
		const after = this.#after
		const inner = new WeakMap<DatabaseConnection, DatabaseConnection>()
		const unwrap = (connection: DatabaseConnection): DatabaseConnection => inner.get(connection) ?? connection
		return {
			init: (options) => driver.init(options),
			async acquireConnection(options) {
				const connection = await driver.acquireConnection(options)
				const wrapped: DatabaseConnection = {
					async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
						const result = await connection.executeQuery<R>(compiled)
						await after(compiled.sql)
						return result
					},
					streamQuery: (compiled, chunkSize) => connection.streamQuery(compiled, chunkSize),
				}
				inner.set(wrapped, connection)
				return wrapped
			},
			beginTransaction: (connection, settings) => driver.beginTransaction(unwrap(connection), settings),
			commitTransaction: (connection) => driver.commitTransaction(unwrap(connection)),
			rollbackTransaction: (connection) => driver.rollbackTransaction(unwrap(connection)),
			releaseConnection: (connection, options) => driver.releaseConnection(unwrap(connection), options),
			destroy: (options) => driver.destroy(options),
		}
	}
}

export function hookedDatabase(url: string, schema: string, after: StatementHook): Database {
	const pool = new SQL({ url, adapter: 'postgres', prepare: false, max: 2, connection: { search_path: schema } })
	return Database.fromDialect(new HookedDialect(pool, after))
}
