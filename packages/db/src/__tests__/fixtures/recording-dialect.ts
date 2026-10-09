import {
	type CompiledQuery,
	type DatabaseConnection,
	type Dialect,
	type Driver,
	type Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
	type QueryResult,
	type TransactionSettings,
} from 'kysely'

/** Records every compiled statement instead of sending it, and answers with no rows. */
export class RecordingDialect implements Dialect {
	readonly log: CompiledQuery[] = []
	/** The settings of every transaction begun, in order. */
	readonly transactions: TransactionSettings[] = []

	createAdapter() {
		return new PostgresAdapter()
	}

	createDriver(): Driver {
		const dialect = this
		const connection: DatabaseConnection = {
			async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
				dialect.log.push(compiled)
				return { rows: [] }
			},
			async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
				yield { rows: [] }
			},
		}
		return {
			async init() {},
			async acquireConnection() {
				return connection
			},
			async beginTransaction(_connection, settings) {
				dialect.transactions.push(settings)
			},
			async commitTransaction() {},
			async rollbackTransaction() {},
			async releaseConnection() {},
			async destroy() {},
		}
	}

	createIntrospector(db: Kysely<unknown>) {
		return new PostgresIntrospector(db)
	}

	createQueryCompiler() {
		return new PostgresQueryCompiler()
	}
}
