import { SQL } from 'bun'
import { CompiledQuery, createQueryId, type Dialect, Kysely, PostgresQueryCompiler, type RootOperationNode, type TransactionBuilder } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import { databaseError, QueryRefusedError } from './errors'
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
		throw new QueryRefusedError('invalid_value', 'an invalid Date cannot be bound')
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
		throw new QueryRefusedError('invalid_name', 'the application id must be lowercase letters, digits and -, at most 59 characters')
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
let transactionBuilder: (database: Database) => TransactionBuilder<LooseDB>
let firstConnection: (database: Database) => Promise<void>

/** The connection the data layer runs on. It has no public query method: everything goes through a store. */
export class Database {
	readonly #kysely: Kysely<LooseDB>
	readonly #schema: string | undefined

	private constructor(kysely: Kysely<LooseDB>, schema: string | undefined) {
		this.#kysely = kysely
		this.#schema = schema
		Object.freeze(this)
	}

	static {
		openSession = (database, readOnly) => new Session(database.#kysely, database.#kysely, readOnly)
		transactionBuilder = (database) => database.#kysely.transaction()
		firstConnection = async (database) => {
			await database.#kysely.executeQuery(CompiledQuery.raw('SELECT 1'))
		}
	}

	/**
	 * Over `Bun.SQL` with `prepare: false`: Bun otherwise keeps one prepared statement per distinct SQL text per
	 * connection, and `in` lists of different lengths make that grow without bound.
	 */
	static postgres(options: PostgresOptions): Database {
		if (!isPlainIdentifier(options.schema)) {
			throw new QueryRefusedError('invalid_name', 'the schema must match ^[a-z_][a-z0-9_]*$')
		}
		const pool = new SQL({ url: options.url, adapter: 'postgres', prepare: false, max: options.max ?? 10, connection: { search_path: options.schema } })
		return new Database(new Kysely<LooseDB>({ dialect: new PostgresJSDialect({ postgres: pool }) }), options.schema)
	}

	/** Any Kysely Postgres dialect; tests use one that records statements instead of sending them. */
	static fromDialect(dialect: Dialect): Database {
		return new Database(new Kysely<LooseDB>({ dialect }), undefined)
	}

	/** The application's schema, the connection's `search_path`; `undefined` over a bare dialect. */
	get schema(): string | undefined {
		return this.#schema
	}

	async close(): Promise<void> {
		await this.#kysely.destroy()
	}
}
// Application modules load after this one: a replaced `postgres` would receive the database URL.
Object.freeze(Database)
Object.freeze(Database.prototype)

/**
 * Opens the pool's first connection, which stays open. A pool with one open connection makes a statement wait for it
 * when the database refuses another (Bun 1.3.14), so only a pool with none fails on a database at its limit: the test
 * kit opens it before a file's first case, where a refusal is waited out instead of failing a case.
 */
export function openFirstConnection(database: Database): Promise<void> {
	return firstConnection(database)
}

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

/** What a session reports to, and asks, the transaction it runs in. */
interface SessionHooks {
	/** Hears of every statement the database refused: in a transaction, Postgres aborts the rest of it. */
	readonly failed?: () => void
	/** Whether the transaction is still the work's: a session kept past it runs nothing on a connection given back. */
	readonly open?: () => boolean
}

/** `work`, or the abort of `signal`, whichever comes first; a `work` left behind still has its rejection handled. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) {
		return work
	}
	work.then(undefined, () => undefined)
	const aborted = new Promise<never>((_resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason)
		}
		signal.addEventListener('abort', () => reject(signal.reason), { once: true })
	})
	return Promise.race([work, aborted])
}

/**
 * Runs guarded operation trees; the only path from the layer to the connection. A driver failure leaves it as a
 * `DatabaseError`, which carries the SQLSTATE and nothing the driver said about the row.
 */
export class Session {
	readonly #executor: Executor
	readonly #kysely: Kysely<LooseDB> | undefined
	readonly #readOnly: boolean
	readonly #hooks: SessionHooks

	constructor(executor: Executor, kysely: Kysely<LooseDB> | undefined, readOnly: boolean, hooks: SessionHooks = {}) {
		this.#executor = executor
		this.#kysely = kysely
		this.#readOnly = readOnly
		this.#hooks = hooks
		Object.freeze(this)
	}

	static {
		executeFixed = async (session, compiled) => (await session.#execute(compiled)).rows
	}

	get readOnly(): boolean {
		return this.#readOnly
	}

	/** Fails the transaction this session runs in, so it commits nothing: a statement refused before it was sent. */
	fail(): void {
		this.#hooks.failed?.()
	}

	async #execute<O>(compiled: CompiledQuery<O>): Promise<{ readonly rows: O[] }> {
		if (this.#hooks.open?.() === false) {
			throw new QueryRefusedError('ended', 'the transaction of this session has ended; it runs nothing more')
		}
		try {
			return await this.#executor.executeQuery(compiled)
		} catch (error) {
			this.#hooks.failed?.()
			throw databaseError(error)
		}
	}

	async run<O>(node: RootOperationNode, context: GuardContext): Promise<O[]> {
		assertAllowedTree(node, context)
		if (this.#readOnly && (context.root !== 'SelectQueryNode' || context.lock !== undefined)) {
			throw new QueryRefusedError('read_only', 'this request is read-only: it reads, and no operation may write or lock a row')
		}
		// CompiledQuery's row type is a phantom: this is the one place where generated row types meet the wire.
		const compiled: CompiledQuery<O> = compiler.compileQuery(node, createQueryId())
		const kysely = this.#kysely
		if (this.#readOnly && kysely !== undefined) {
			try {
				const result = await kysely.transaction().setAccessMode('read only').execute((transaction) => transaction.executeQuery(compiled))
				return result.rows
			} catch (error) {
				throw databaseError(error)
			}
		}
		const result = await this.#execute(compiled)
		return result.rows
	}

	/**
	 * Runs `work` in one transaction (`READ ONLY` in a read-only session); inside one, it runs in the transaction already
	 * open. When `signal` aborts, the transaction rolls back and its connection goes back to the pool at once, whether
	 * `work` returned or not; its session then runs nothing more.
	 */
	async transaction<T>(work: (session: Session) => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (this.#kysely === undefined) {
			return work(this)
		}
		const builder = this.#kysely.transaction()
		let open = true
		let failed = false
		let failure: { readonly error: unknown } | undefined
		try {
			return await (this.#readOnly ? builder.setAccessMode('read only') : builder).execute(async (transaction) => {
				try {
					const hooks: SessionHooks = {
						open: () => open,
						failed: () => {
							failed = true
						},
					}
					const result = await untilAborted(work(new Session(transaction, undefined, this.#readOnly, hooks)), signal)
					// A failure the work caught: Postgres would answer the COMMIT of an aborted transaction with a silent ROLLBACK.
					if (failed) {
						throw new QueryRefusedError('statement_failed', 'a statement of this transaction failed, so nothing it wrote commits')
					}
					return result
				} catch (error) {
					failure = { error }
					throw error
				} finally {
					open = false
				}
			})
		} catch (error) {
			// The work's own error passes through; only BEGIN, COMMIT and ROLLBACK failures are the driver's.
			throw failure !== undefined && failure.error === error ? error : databaseError(error)
		}
	}
}
Object.freeze(Session.prototype)

/** How long an invocation's transaction may sit idle before Postgres ends it, and its connection with it. */
export const INVOCATION_IDLE_TIMEOUT_MS = 30_000

const SQL_IDLE_TIMEOUT = "select set_config('idle_in_transaction_session_timeout', $1, true)"

/** What the invocation's transaction body throws to roll back; never seen outside this module. */
class RolledBack extends Error {}

/**
 * The one transaction of an invocation (a request, a webhook delivery): opened by its first statement, then ended
 * once by the framework — committed after the handler returned and its output passed validation, rolled back
 * otherwise. Every handle of the invocation runs in `session()`. Ending it and giving its connection back are two
 * states: once ended no statement runs in it, and the connection is back in the pool whether the COMMIT succeeded,
 * failed, or the connection died.
 */
export class InvocationTransaction {
	readonly #database: Database
	readonly #readOnly: boolean
	readonly #decision = Promise.withResolvers<'commit' | 'rollback'>()
	#opened: Promise<Session> | undefined
	#run: Promise<void> | undefined
	#released: Promise<void> = Promise.resolve()
	#isReleased = true
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

	/** Marks it failed, so it commits nothing: a statement refused before it was sent, even when the handler caught it. */
	fail(): void {
		this.#failed = true
	}

	/** No statement runs in it any more. */
	get ended(): boolean {
		return this.#ended
	}

	/** Its connection is back in the pool (or it never took one). */
	get released(): boolean {
		return this.#isReleased
	}

	/** The session the invocation's statements run in; the first call opens the transaction. */
	session(): Promise<Session> {
		if (this.#ended) {
			return Promise.reject(new QueryRefusedError('ended', 'this invocation has ended; its data handles run only while its handler runs'))
		}
		this.#opened ??= this.#open()
		return this.#opened
	}

	#open(): Promise<Session> {
		const ready = Promise.withResolvers<Session>()
		this.#isReleased = false
		const builder = transactionBuilder(this.#database)
		const run = (this.#readOnly ? builder.setAccessMode('read only') : builder).execute(async (transaction) => {
			const session = new Session(transaction, undefined, this.#readOnly, {
				failed: () => {
					this.#failed = true
				},
				open: () => !this.#ended,
			})
			await executeFixed(session, CompiledQuery.raw(SQL_IDLE_TIMEOUT, [String(INVOCATION_IDLE_TIMEOUT_MS)]))
			ready.resolve(session)
			if ((await this.#decision.promise) === 'rollback') {
				throw new RolledBack()
			}
		})
		this.#run = run
		this.#released = run.then(() => undefined, () => undefined).finally(() => {
			this.#isReleased = true
		})
		run.catch((error: unknown) => ready.reject(databaseError(error)))
		return ready.promise
	}

	/**
	 * Commits what the invocation wrote. A statement the database refused aborted the transaction, so it rolls back
	 * and throws instead: Postgres would answer the COMMIT with a silent ROLLBACK. A failed COMMIT throws a
	 * `DatabaseError`, after the connection is back in the pool.
	 */
	async commit(): Promise<void> {
		if (this.#ended) {
			throw new QueryRefusedError('ended', 'this invocation has already ended')
		}
		this.#ended = true
		const run = this.#run
		if (this.#failed) {
			this.#decision.resolve('rollback')
			await this.#released
			throw new QueryRefusedError('statement_failed', 'a statement of this invocation failed, so nothing it wrote commits')
		}
		if (run === undefined) {
			return
		}
		this.#decision.resolve('commit')
		try {
			await run
		} catch (error) {
			throw databaseError(error)
		} finally {
			await this.#released
		}
	}

	/** Discards what the invocation wrote; idempotent, never throws, and returns once the connection is back. */
	async rollback(): Promise<void> {
		this.#ended = true
		this.#decision.resolve('rollback')
		await this.#released
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

/** A bound parameter of an application's own statement (`sql.ts`), after its value was encoded for the driver. */
export type SqlParameter = string | number | boolean | bigint | null

/**
 * One `ctx.sql` statement, whose text `sql.ts` classified and whose values are bound parameters only. It runs through the
 * session's one path to the connection, so a statement the database refuses fails the invocation it runs in.
 */
export function runApplicationStatement(session: Session, text: string, parameters: readonly SqlParameter[]): Promise<readonly unknown[]> {
	return executeFixed(session, CompiledQuery.raw(text, [...parameters]))
}
