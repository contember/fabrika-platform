// A `bun:sqlite` database shaped like a Durable Object's storage, for the tests and the SQLite test kit. Not a subpath:
// a Worker never loads it.

import { Database, type SQLQueryBindings } from 'bun:sqlite'
import type { SqliteCursor, SqliteStorage, SqliteValue } from './sqlite'

export interface BunSqliteStorage extends SqliteStorage {
	/** Runs `fn` in one transaction of its own, as a Durable Object's `storage.transactionSync` does. */
	transactionSync<T>(fn: () => T): T
}

/** workerd's authorizer refuses these in `sql.exec`: a transaction runs through `transaction` or `transactionSync`. */
const TRANSACTION_CONTROL = /(?:^|;)(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:begin|commit|end|rollback|savepoint|release)\b/i

function bunBinding(value: SqliteValue): SQLQueryBindings {
	return value instanceof ArrayBuffer ? new Uint8Array(value) : value
}

/** A column value as workerd answers it: a BLOB is an `ArrayBuffer`. */
function storageValue(value: unknown): SqliteValue {
	if (value === null || typeof value === 'string' || typeof value === 'number') {
		return value
	}
	if (value instanceof Uint8Array) {
		return value.slice().buffer
	}
	throw new Error('bun:sqlite answered a value a Durable Object never does')
}

function storageRow(row: Record<string, unknown>): Record<string, SqliteValue> {
	return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, storageValue(value)]))
}

/**
 * `database` (a fresh `:memory:` one by default) with foreign keys enforced, as a Durable Object enforces them. One
 * `transaction` runs at a time; a statement outside one runs at once. A text of several statements runs whole when its
 * first statement answers no rows, as a migration's does; otherwise only its first statement runs.
 */
export function bunSqliteStorage(database: Database = new Database(':memory:')): BunSqliteStorage {
	database.run('PRAGMA foreign_keys = ON')
	const totalChanges = (): number => database.query<{ readonly changes: number }, []>('select total_changes() as changes').get()?.changes ?? 0
	let queue: Promise<void> = Promise.resolve()

	function exec(query: string, ...bindings: SqliteValue[]): SqliteCursor {
		if (TRANSACTION_CONTROL.test(query)) {
			throw new Error('sql.exec runs no transaction statement: use storage.transaction() or storage.transactionSync()')
		}
		const values = bindings.map(bunBinding)
		const before = totalChanges()
		const statement = database.prepare<Record<string, unknown>, SQLQueryBindings[]>(query)
		let rows: Record<string, SqliteValue>[] = []
		try {
			if (statement.columnNames.length > 0) {
				rows = statement.all(...values).map(storageRow)
			} else {
				database.run(query, values)
			}
		} finally {
			statement.finalize()
		}
		const rowsWritten = totalChanges() - before
		return { toArray: () => rows, rowsWritten }
	}

	return {
		sql: { exec },
		async transaction<T>(closure: () => Promise<T>): Promise<T> {
			const previous = queue
			const done = Promise.withResolvers<void>()
			queue = previous.then(() => done.promise)
			await previous
			try {
				database.run('BEGIN')
				try {
					const result = await closure()
					database.run('COMMIT')
					return result
				} catch (error) {
					if (database.inTransaction) {
						database.run('ROLLBACK')
					}
					throw error
				}
			} finally {
				done.resolve()
			}
		},
		transactionSync<T>(fn: () => T): T {
			database.run('BEGIN')
			try {
				const result = fn()
				database.run('COMMIT')
				return result
			} catch (error) {
				if (database.inTransaction) {
					database.run('ROLLBACK')
				}
				throw error
			}
		},
	}
}
