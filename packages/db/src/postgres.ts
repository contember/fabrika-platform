import { SQL } from 'bun'
import { PostgresJSDialect } from 'kysely-postgres-js'
import { Database } from './database'
import { QueryRefusedError } from './errors'
import { isPlainIdentifier } from './identifier'

export interface PostgresOptions {
	readonly url: string
	/** The application's schema (`app_<id>`), set as the connection's `search_path`. */
	readonly schema: string
	readonly max?: number
}

/**
 * Over `Bun.SQL` with `prepare: false`: Bun otherwise keeps one prepared statement per distinct SQL text per
 * connection, and `in` lists of different lengths make that grow without bound.
 */
export function openPostgres(options: PostgresOptions): Database {
	if (!isPlainIdentifier(options.schema)) {
		throw new QueryRefusedError('invalid_name', 'the schema must match ^[a-z_][a-z0-9_]*$')
	}
	const pool = new SQL({ url: options.url, adapter: 'postgres', prepare: false, max: options.max ?? 10, connection: { search_path: options.schema } })
	return Database.fromDialect(new PostgresJSDialect({ postgres: pool }), { schema: options.schema })
}
// Application modules load after this one: a replaced opener would receive the database URL.
Object.freeze(openPostgres)
