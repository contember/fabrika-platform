// A `bun:sqlite` database shaped like a Durable Object's storage, for the tests and the SQLite test kit. Not a subpath:
// a Worker never loads it.

import { Database, type SQLQueryBindings } from 'bun:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SqliteCursor, SqliteStorage, SqliteValue } from './sqlite'

export interface BunSqliteStorage extends SqliteStorage {
	/** Runs `fn` in one transaction of its own, as a Durable Object's `storage.transactionSync` does. */
	transactionSync<T>(fn: () => T): T
}

/** workerd's authorizer refuses these in `sql.exec`: a transaction runs through `transaction` or `transactionSync`. */
const TRANSACTION_CONTROL = /(?:^|;)(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:begin|commit|end|rollback|savepoint|release)\b/i

/** workerd's `SQLITE_LIMIT_COLUMN` and `SQLITE_LIMIT_VARIABLE_NUMBER`, both 100. */
const WORKERD_MAX_COLUMNS = 100

/** What may follow a text's last statement: whitespace, comments and semicolons. */
const NO_STATEMENT = /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/

/**
 * Runs each statement of `query` in turn and answers the rows of the last one, as a Durable Object's `sql.exec` does.
 * bun:sqlite's `prepare` compiles only the first statement of a text, and its column count cannot tell a migration from a
 * read (`ALTER TABLE … ADD COLUMN … CHECK (…)` reports one column), so the text is split at the end of each compiled
 * statement. `bindings` belong to a text of one statement. Refuses what workerd's SQLite refuses: more than 100 result
 * columns or parameters in one statement.
 */
export function execStatements(database: Database, query: string, bindings: readonly SQLQueryBindings[] = []): Record<string, unknown>[] {
	let text = query
	for (;;) {
		const statement = database.prepare<Record<string, unknown>, SQLQueryBindings[]>(text)
		try {
			if (statement.columnNames.length > WORKERD_MAX_COLUMNS) {
				throw new Error('too many columns in result set: SQLITE_ERROR')
			}
			if (statement.paramsCount > WORKERD_MAX_COLUMNS) {
				throw new Error('too many SQL variables: SQLITE_ERROR')
			}
			// The compiled statement's own text, with no parameter to expand: the rest of `text` follows it verbatim.
			const compiled = statement.toString()
			const rest = bindings.length === 0 && text.startsWith(compiled) ? text.slice(compiled.length) : ''
			const rows = statement.all(...bindings)
			if (NO_STATEMENT.test(rest)) {
				return rows
			}
			text = rest
		} finally {
			statement.finalize()
		}
	}
}

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

/** The transaction a `transaction` callback runs in: its savepoint depth, and the queue its own nested ones wait in. */
interface OpenTransaction {
	readonly depth: number
	queue: Promise<void>
}

/**
 * `database` (a fresh `:memory:` one by default) with foreign keys enforced, as a Durable Object enforces them. One
 * `transaction` runs at a time; one started inside a callback nests in a savepoint, as workerd nests it, and its
 * siblings wait for each other. A statement outside one runs at once. A text of several statements runs each of them and
 * answers the rows of the last (`execStatements`).
 */
export function bunSqliteStorage(database: Database = new Database(':memory:')): BunSqliteStorage {
	database.run('PRAGMA foreign_keys = ON')
	const totalChanges = (): number => database.query<{ readonly changes: number }, []>('select total_changes() as changes').get()?.changes ?? 0
	const root: OpenTransaction = { depth: 0, queue: Promise.resolve() }
	const open = new AsyncLocalStorage<OpenTransaction>()

	function exec(query: string, ...bindings: SqliteValue[]): SqliteCursor {
		if (TRANSACTION_CONTROL.test(query)) {
			throw new Error('sql.exec runs no transaction statement: use storage.transaction() or storage.transactionSync()')
		}
		const before = totalChanges()
		const rows = execStatements(database, query, bindings.map(bunBinding)).map(storageRow)
		const rowsWritten = totalChanges() - before
		return { toArray: () => rows, rowsWritten }
	}

	return {
		sql: { exec },
		async transaction<T>(closure: () => Promise<T>): Promise<T> {
			const parent = open.getStore() ?? root
			const previous = parent.queue
			const done = Promise.withResolvers<void>()
			parent.queue = previous.then(() => done.promise)
			await previous
			const depth = parent.depth + 1
			const savepoint = `_test_savepoint_${depth}`
			try {
				database.run(depth === 1 ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
				try {
					const result = await open.run({ depth, queue: Promise.resolve() }, closure)
					database.run(depth === 1 ? 'COMMIT' : `RELEASE ${savepoint}`)
					return result
				} catch (error) {
					if (depth === 1 && database.inTransaction) {
						database.run('ROLLBACK')
					} else if (depth > 1) {
						database.run(`ROLLBACK TO ${savepoint}`)
						database.run(`RELEASE ${savepoint}`)
					}
					throw error
				}
			} finally {
				done.resolve()
			}
		},
		transactionSync<T>(fn: () => T): T {
			// Inside an open transaction workerd nests it in a savepoint too.
			const nested = database.inTransaction
			database.run(nested ? 'SAVEPOINT _test_sync_savepoint' : 'BEGIN')
			try {
				const result = fn()
				database.run(nested ? 'RELEASE _test_sync_savepoint' : 'COMMIT')
				return result
			} catch (error) {
				if (nested) {
					database.run('ROLLBACK TO _test_sync_savepoint')
					database.run('RELEASE _test_sync_savepoint')
				} else if (database.inTransaction) {
					database.run('ROLLBACK')
				}
				throw error
			}
		},
	}
}
