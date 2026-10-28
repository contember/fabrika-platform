// A `Database` on a real Postgres whose statements run as sent, while a hook may hold back a statement before it runs or
// its answer after: a test interleaves two runs at a point no application hook reaches (a run's finish, its pending check).

import { Database } from '@fabrika/db'
import { SQL } from 'bun'
import type { CompiledQuery, DatabaseConnection, Dialect, Driver, QueryResult } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'

export type StatementHook = (query: CompiledQuery) => Promise<void>

export interface StatementHooks {
	/** Runs before `query` is sent. */
	readonly before?: StatementHook
	/** Runs after `query` executed and before its caller sees the answer. */
	readonly after?: StatementHook
}

function delayed(base: Dialect, hooks: StatementHooks): Dialect {
	return {
		createAdapter: () => base.createAdapter(),
		createQueryCompiler: () => base.createQueryCompiler(),
		createIntrospector: (db) => base.createIntrospector(db),
		createDriver(): Driver {
			const driver = base.createDriver()
			const underlying = new WeakMap<DatabaseConnection, DatabaseConnection>()
			const original = (connection: DatabaseConnection): DatabaseConnection => {
				const found = underlying.get(connection)
				if (found === undefined) throw new Error('a connection this driver did not hand out')
				return found
			}
			return {
				init: () => driver.init(),
				destroy: () => driver.destroy(),
				async acquireConnection() {
					const connection = await driver.acquireConnection()
					const wrapped: DatabaseConnection = {
						async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
							await hooks.before?.(query)
							const result = await connection.executeQuery<R>(query)
							await hooks.after?.(query)
							return result
						},
						streamQuery: (query, chunkSize) => connection.streamQuery(query, chunkSize),
					}
					underlying.set(wrapped, connection)
					return wrapped
				},
				releaseConnection: (connection) => driver.releaseConnection(original(connection)),
				beginTransaction: (connection, settings) => driver.beginTransaction(original(connection), settings),
				commitTransaction: (connection) => driver.commitTransaction(original(connection)),
				rollbackTransaction: (connection) => driver.rollbackTransaction(original(connection)),
			}
		},
	}
}

export function delayedDatabase(url: string, schema: string, hooks: StatementHooks): Database {
	const pool = new SQL({ url, adapter: 'postgres', prepare: false, max: 4, connection: { search_path: schema } })
	return Database.fromDialect(delayed(new PostgresJSDialect({ postgres: pool }), hooks))
}
