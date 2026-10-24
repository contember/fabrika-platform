// @fabrika/db/sqlite — the data layer's engine over a Cloudflare Durable Object's SQLite (ADR-0065). Worker-safe: no
// Bun import. `sqlite-bun.ts` gives the tests a `bun:sqlite` database of the same shape.

import {
	type BinaryOperationNode,
	type CompiledQuery,
	type DatabaseConnection,
	type DatabaseIntrospector,
	type Dialect,
	type DialectAdapter,
	type Driver,
	Kysely,
	OperatorNode,
	type QueryResult,
	type SelectModifierNode,
	type SelectQueryNode,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from 'kysely'
import { Database, freezePrototypeChain, type LooseDB, type TransactionRunner } from './database'
import { DatabaseError, QueryRefusedError } from './errors'

/** A value `sql.exec` binds and answers; a Durable Object's `SqlStorageValue`. */
export type SqliteValue = ArrayBuffer | string | number | null

export interface SqliteCursor {
	toArray(): Record<string, SqliteValue>[]
	readonly rowsWritten: number
}

/** What the engine needs of a Durable Object's `ctx.storage`; `DurableObjectStorage` is assignable to it. */
export interface SqliteStorage {
	readonly sql: {
		exec(query: string, ...bindings: SqliteValue[]): SqliteCursor
	}
	/** Commits when `closure` resolves, rolls back when it rejects; the object serves no other event meanwhile. */
	transaction<T>(closure: () => Promise<T>): Promise<T>
	/** Runs `closure` in one transaction of its own, nested in a savepoint inside an open one; rolls back when it throws. */
	transactionSync<T>(closure: () => T): T
}

const LIKE_OPERATORS: ReadonlyMap<string, string> = new Map([
	['like', 'like'],
	['ilike', 'like'],
	['not like', 'not like'],
	['not ilike', 'not like'],
])

/** The modifiers a Durable Object needs none of: while a transaction is open it serves no other event. */
const LOCK_MODIFIERS: ReadonlySet<string> = new Set(['ForUpdate', 'ForShare', 'ForKeyShare', 'ForNoKeyUpdate', 'NoWait', 'SkipLocked'])

function isLockModifier(modifier: SelectModifierNode): boolean {
	return modifier.modifier !== undefined && LOCK_MODIFIERS.has(modifier.modifier)
}

/**
 * SQLite's forms of what the layer binds and builds. LIKE takes `\` as its escape character only when told, so every
 * pattern gets `escape '\'`, as Postgres has by default; `ilike` is `like`, case-insensitive for ASCII only.
 */
class SqliteCompiler extends SqliteQueryCompiler {
	protected override addParameter(parameter: unknown): void {
		super.addParameter(sqliteParameter(parameter))
	}

	protected override visitBinaryOperation(node: BinaryOperationNode): void {
		const pattern = OperatorNode.is(node.operator) ? LIKE_OPERATORS.get(node.operator.operator) : undefined
		if (pattern === undefined) {
			super.visitBinaryOperation(node)
			return
		}
		this.visitNode(node.leftOperand)
		this.append(` ${pattern} `)
		this.visitNode(node.rightOperand)
		this.append(" escape '\\'")
	}

	protected override visitSelectQuery(node: SelectQueryNode): void {
		const modifiers = node.endModifiers?.filter((modifier) => !isLockModifier(modifier))
		super.visitSelectQuery({ ...node, endModifiers: modifiers === undefined || modifiers.length === 0 ? undefined : modifiers })
	}
}

function sqliteParameter(parameter: unknown): unknown {
	if (parameter instanceof Date) {
		if (Number.isNaN(parameter.getTime())) {
			throw new QueryRefusedError('invalid_value', 'an invalid Date cannot be bound')
		}
		return parameter.toISOString()
	}
	if (typeof parameter === 'boolean') {
		return parameter ? 1 : 0
	}
	if (typeof parameter === 'bigint') {
		const value = Number(parameter)
		if (!Number.isSafeInteger(value)) {
			throw new QueryRefusedError('invalid_value', 'a bigint outside the safe integer range cannot be bound on SQLite')
		}
		return value
	}
	return parameter
}

const sqliteCompiler = new SqliteCompiler()
freezePrototypeChain(sqliteCompiler)

function binding(value: unknown): SqliteValue {
	if (value === null || typeof value === 'string' || typeof value === 'number' || value instanceof ArrayBuffer) {
		return value
	}
	throw new QueryRefusedError('invalid_value', 'a value SQLite cannot bind: string, number, ArrayBuffer or null')
}

/** The SQLSTATE of each constraint failure, by the start of the message workerd and bun:sqlite both give. */
const CONSTRAINT_STATES: readonly (readonly [string, string])[] = Object.freeze([
	['UNIQUE constraint failed', '23505'],
	['FOREIGN KEY constraint failed', '23503'],
	['CHECK constraint failed', '23514'],
	['NOT NULL constraint failed', '23502'],
])

/** The driver's failure as a `DatabaseError`; its message can quote row values, so none of it is kept. */
function sqliteError(error: unknown): DatabaseError {
	if (error instanceof DatabaseError) {
		return error
	}
	const message = error instanceof Error ? error.message : ''
	const match = CONSTRAINT_STATES.find(([prefix]) => message.startsWith(prefix))
	return new DatabaseError(match === undefined ? null : match[1])
}

/** Postgres's SQLSTATE for a write in a `READ ONLY` transaction, which the backstop answers too. */
const READ_ONLY_TRANSACTION = '25006'

/**
 * A read-only statement's rows, run in a `transactionSync` of its own that holds nothing across an await. A statement
 * that wrote throws, which rolls back what it wrote: the backstop below the layer's refusal of a write node.
 */
function readRows(storage: SqliteStorage, query: string, bindings: SqliteValue[]): Record<string, SqliteValue>[] {
	return storage.transactionSync(() => {
		const cursor = storage.sql.exec(query, ...bindings)
		// workerd counts `rowsWritten` as the cursor is read: only a consumed cursor reports the whole statement.
		const rows = cursor.toArray()
		if (cursor.rowsWritten > 0) {
			throw new DatabaseError(READ_ONLY_TRANSACTION)
		}
		return rows
	})
}

function connectionOf(storage: SqliteStorage, readOnly: boolean): DatabaseConnection {
	return {
		async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
			const bindings = compiled.parameters.map(binding)
			let rows: Record<string, SqliteValue>[]
			try {
				rows = readOnly ? readRows(storage, compiled.sql, bindings) : storage.sql.exec(compiled.sql, ...bindings).toArray()
			} catch (error) {
				throw sqliteError(error)
			}
			// Untyped rows become the caller's row type, as Bun.SQL's `any` rows do on Postgres.
			return { rows: rows as R[] }
		},
		streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
			throw new QueryRefusedError('statement_shape', 'a SQLite database does not stream a query')
		},
	}
}

function refuseKyselyTransaction(): Promise<never> {
	return Promise.reject(new QueryRefusedError('statement_shape', "a SQLite transaction runs through the storage's transaction, never Kysely's"))
}

class SqliteDialect implements Dialect {
	readonly #storage: SqliteStorage
	readonly #readOnly: boolean

	constructor(storage: SqliteStorage, readOnly: boolean) {
		this.#storage = storage
		this.#readOnly = readOnly
	}

	createAdapter(): DialectAdapter {
		return new SqliteAdapter()
	}

	createDriver(): Driver {
		const connection = connectionOf(this.#storage, this.#readOnly)
		return {
			async init() {},
			async acquireConnection() {
				return connection
			},
			beginTransaction: refuseKyselyTransaction,
			commitTransaction: refuseKyselyTransaction,
			rollbackTransaction: refuseKyselyTransaction,
			async releaseConnection() {},
			async destroy() {},
		}
	}

	createQueryCompiler(): SqliteQueryCompiler {
		return sqliteCompiler
	}

	createIntrospector(db: Kysely<LooseDB>): DatabaseIntrospector {
		return new SqliteIntrospector(db)
	}
}

/**
 * The data layer's database over a Durable Object's storage. A read-only transaction opens no storage transaction,
 * which would hold back every other event of the object across the work's awaits: each of its statements runs in one
 * of its own, so two of them may see different committed states, as under Postgres's READ COMMITTED. The idle timeout
 * has no SQLite form.
 */
export function openSqlite(storage: SqliteStorage): Database {
	const kysely = new Kysely<LooseDB>({ dialect: new SqliteDialect(storage, false) })
	const reads = new Kysely<LooseDB>({ dialect: new SqliteDialect(storage, true) })
	const transaction: TransactionRunner = (options, body) => options.readOnly ? body(reads) : storage.transaction(() => body(kysely))
	return Database.fromEngine({ dialect: 'sqlite', kysely, compiler: sqliteCompiler, transaction })
}
// Application modules load after this one: a replaced opener would receive the object's storage.
Object.freeze(openSqlite)
