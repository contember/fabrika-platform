import { SQL } from 'bun'
import { CompiledQuery, type ControlledTransaction, createQueryId, type Dialect, Kysely, PostgresQueryCompiler, type RootOperationNode } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import { QueryRefusedError } from './errors'
import { assertAllowedTree, type GuardContext } from './guard'
import { isPlainIdentifier } from './identifier'

type LooseDB = Record<string, Record<string, unknown>>
type Executor = Pick<Kysely<LooseDB>, 'executeQuery'>

/**
 * With `prepare: false`, Bun.SQL sends every parameter as text and a Date as `Date#toString()`, which Postgres
 * refuses as a timestamp. Every guarded tree compiles here, so every Date parameter of the layer is bound as ISO text.
 */
class ParameterCompiler extends PostgresQueryCompiler {
	protected override addParameter(parameter: unknown): void {
		super.addParameter(parameter instanceof Date ? timestampText(parameter) : parameter)
	}
}

function timestampText(date: Date): string {
	if (Number.isNaN(date.getTime())) {
		throw new QueryRefusedError('an invalid Date cannot be bound')
	}
	return date.toISOString()
}

const compiler = new ParameterCompiler()
freezePrototypeChain(compiler)

/**
 * The compiler turns the guarded tree into SQL, so a patch to it after the guard ran would bypass the guard.
 * Freezing it when this module loads, before application modules, makes such a patch throw instead.
 */
function freezePrototypeChain(object: object): void {
	let current: object | null = object
	while (current !== null && current !== Object.prototype) {
		Object.freeze(current)
		current = Object.getPrototypeOf(current)
	}
}

/** IAM's application id alphabet; `-` maps to `_`, which the alphabet lacks, so two ids never share a schema. */
const APP_ID = /^[a-z0-9][a-z0-9-]*$/
/** Postgres truncates identifiers to 63 bytes; `app_` takes four of them. */
const MAX_APP_ID_LENGTH = 59

/**
 * `app_<id>`, the schema an application's migrations create (ADR-0017). `@fabrika/platform-node`'s
 * `applicationDatabaseSchema` derives the same name for the migration runner; the two must agree.
 */
export function applicationSchema(appId: string): string {
	if (!APP_ID.test(appId) || appId.length > MAX_APP_ID_LENGTH) {
		throw new QueryRefusedError('the application id must be lowercase letters, digits and -, at most 59 characters')
	}
	return `app_${appId.replaceAll('-', '_')}`
}

export interface PostgresOptions {
	readonly url: string
	/** The application's schema (`app_<id>`), set as the connection's `search_path`. */
	readonly schema: string
	readonly max?: number
}

let openSession: (database: Database, readOnly: boolean) => Session
let startTransaction: (database: Database, readOnly: boolean) => Promise<ControlledTransaction<LooseDB>>

/** The connection the data layer runs on. It has no public query method: everything goes through a store. */
export class Database {
	readonly #kysely: Kysely<LooseDB>

	private constructor(kysely: Kysely<LooseDB>) {
		this.#kysely = kysely
		Object.freeze(this)
	}

	static {
		openSession = (database, readOnly) => new Session(database.#kysely, database.#kysely, readOnly)
		startTransaction = (database, readOnly) => {
			const builder = database.#kysely.startTransaction()
			return (readOnly ? builder.setAccessMode('read only') : builder).execute()
		}
	}

	/**
	 * Over `Bun.SQL` with `prepare: false`: Bun otherwise keeps one prepared statement per distinct SQL text per
	 * connection, and `in` lists of different lengths make that grow without bound.
	 */
	static postgres(options: PostgresOptions): Database {
		if (!isPlainIdentifier(options.schema)) {
			throw new QueryRefusedError('the schema must match ^[a-z_][a-z0-9_]*$')
		}
		const pool = new SQL({ url: options.url, adapter: 'postgres', prepare: false, max: options.max ?? 10, connection: { search_path: options.schema } })
		return new Database(new Kysely<LooseDB>({ dialect: new PostgresJSDialect({ postgres: pool }) }))
	}

	/** Any Kysely Postgres dialect; tests use one that records statements instead of sending them. */
	static fromDialect(dialect: Dialect): Database {
		return new Database(new Kysely<LooseDB>({ dialect }))
	}

	async close(): Promise<void> {
		await this.#kysely.destroy()
	}
}
// Application modules load after this one: a replaced `postgres` would receive the database URL.
Object.freeze(Database)
Object.freeze(Database.prototype)

/** The connection a session runs on, and whether the request running now may only read. */
export interface SessionSource {
	readonly database: Database
	readonly readOnly?: () => boolean
}

/**
 * The one way to a session: every statement of a request — a store's, a locator's, a framework table's — asks the
 * runtime whether the request is read-only. A read-only session refuses every write and lock before it reaches the
 * database, and reads in `READ ONLY` transactions.
 */
export function sessionOf(source: SessionSource): Session {
	return openSession(source.database, source.readOnly?.() === true)
}

let executeFixed: (session: Session, compiled: CompiledQuery) => Promise<readonly unknown[]>

/** Runs guarded operation trees; the only path from the layer to the connection. */
export class Session {
	readonly #executor: Executor
	readonly #kysely: Kysely<LooseDB> | undefined
	readonly #readOnly: boolean
	readonly #failed: (() => void) | undefined

	/** `failed` hears of every statement the database refused: in a transaction, Postgres aborts the rest of it. */
	constructor(executor: Executor, kysely: Kysely<LooseDB> | undefined, readOnly: boolean, failed?: () => void) {
		this.#executor = executor
		this.#kysely = kysely
		this.#readOnly = readOnly
		this.#failed = failed
		Object.freeze(this)
	}

	static {
		executeFixed = async (session, compiled) => (await session.#execute(compiled)).rows
	}

	get readOnly(): boolean {
		return this.#readOnly
	}

	async #execute<O>(compiled: CompiledQuery<O>): Promise<{ readonly rows: O[] }> {
		try {
			return await this.#executor.executeQuery(compiled)
		} catch (error) {
			this.#failed?.()
			throw error
		}
	}

	async run<O>(node: RootOperationNode, context: GuardContext): Promise<O[]> {
		assertAllowedTree(node, context)
		if (this.#readOnly && (context.root !== 'SelectQueryNode' || context.lock !== undefined)) {
			throw new QueryRefusedError('this request is read-only: it reads, and no operation may write or lock a row')
		}
		// CompiledQuery's row type is a phantom: this is the one place where generated row types meet the wire.
		const compiled: CompiledQuery<O> = compiler.compileQuery(node, createQueryId())
		const kysely = this.#kysely
		if (this.#readOnly && kysely !== undefined) {
			const result = await kysely.transaction().setAccessMode('read only').execute((transaction) => transaction.executeQuery(compiled))
			return result.rows
		}
		const result = await this.#execute(compiled)
		return result.rows
	}

	/** Runs `work` in one transaction (`READ ONLY` in a read-only session); inside one, it runs in the transaction already open. */
	async transaction<T>(work: (session: Session) => Promise<T>): Promise<T> {
		if (this.#kysely === undefined) {
			return work(this)
		}
		const builder = this.#kysely.transaction()
		return (this.#readOnly ? builder.setAccessMode('read only') : builder).execute((transaction) =>
			work(new Session(transaction, undefined, this.#readOnly))
		)
	}
}
Object.freeze(Session.prototype)

/** How long an invocation's transaction may sit idle before Postgres ends it, and its connection with it. */
export const INVOCATION_IDLE_TIMEOUT_MS = 30_000

const SQL_IDLE_TIMEOUT = "select set_config('idle_in_transaction_session_timeout', $1, true)"

interface Opened {
	readonly transaction: ControlledTransaction<LooseDB>
	readonly session: Session
}

/**
 * The one transaction of an invocation (a request, a webhook delivery): opened by its first statement, then ended
 * once by the framework — committed after the handler returned and its output passed validation, rolled back
 * otherwise. Every handle of the invocation runs in `session()`. Once ended, no statement runs in it again.
 */
export class InvocationTransaction {
	readonly #database: Database
	readonly #readOnly: boolean
	#opened: Promise<Opened> | undefined
	#ended = false
	#failed = false

	constructor(database: Database, readOnly: boolean) {
		this.#database = database
		this.#readOnly = readOnly
	}

	/** A `READ ONLY` transaction: a query's or an export's. */
	get readOnly(): boolean {
		return this.#readOnly
	}

	/** Whether the transaction was opened: an invocation that reached no data commits nothing. */
	get opened(): boolean {
		return this.#opened !== undefined
	}

	get ended(): boolean {
		return this.#ended
	}

	/** The session the invocation's statements run in; the first call opens the transaction. */
	session(): Promise<Session> {
		if (this.#ended) {
			return Promise.reject(new QueryRefusedError('this invocation has ended; its data handles run only while its handler runs'))
		}
		this.#opened ??= this.#open()
		return this.#opened.then((opened) => opened.session)
	}

	async #open(): Promise<Opened> {
		const transaction = await startTransaction(this.#database, this.#readOnly)
		const session = new Session(transaction, undefined, this.#readOnly, () => {
			this.#failed = true
		})
		try {
			await executeFixed(session, CompiledQuery.raw(SQL_IDLE_TIMEOUT, [String(INVOCATION_IDLE_TIMEOUT_MS)]))
		} catch (error) {
			await transaction.rollback().execute()
			throw error
		}
		return { transaction, session }
	}

	/**
	 * Commits what the invocation wrote. A statement the database refused aborted the transaction, so it rolls back
	 * and throws instead: Postgres would answer the COMMIT with a silent ROLLBACK.
	 */
	async commit(): Promise<void> {
		if (this.#ended) {
			throw new QueryRefusedError('this invocation has already ended')
		}
		this.#ended = true
		const opened = this.#opened
		if (opened === undefined) {
			return
		}
		const { transaction } = await opened
		if (this.#failed) {
			await transaction.rollback().execute()
			throw new QueryRefusedError('a statement of this invocation failed, so nothing it wrote commits')
		}
		await transaction.commit().execute()
	}

	/** Discards what the invocation wrote; idempotent, and never throws over the failure that caused it. */
	async rollback(): Promise<void> {
		if (this.#ended) {
			return
		}
		this.#ended = true
		const opened = this.#opened
		if (opened === undefined) {
			return
		}
		try {
			const { transaction } = await opened
			await transaction.rollback().execute()
		} catch {
			// The transaction never opened, or its connection is gone; either way nothing of it commits.
		}
	}
}
Object.freeze(InvocationTransaction.prototype)

/**
 * A scalar parameter of a framework statement; Bun.SQL mis-binds arrays and JSON strings. No Date: these texts skip
 * the compiler that binds one, and a lease time is the database's clock, never the process's.
 */
export type FixedParameter = string | number | null

/**
 * One of the framework's own fixed statements (`job-leases.ts`): a constant text with scalar parameters. They need
 * what the guard refuses on purpose (`now()`, `set_config`, `pg_backend_pid()`, `on conflict`), so they bypass it;
 * no subpath exports this, and no text is ever built from a caller's value.
 */
export function runFixedStatement(session: Session, text: string, parameters: readonly FixedParameter[]): Promise<readonly unknown[]> {
	return executeFixed(session, CompiledQuery.raw(text, [...parameters]))
}
