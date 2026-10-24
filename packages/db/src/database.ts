import { CompiledQuery, createQueryId, type Dialect, Kysely, PostgresQueryCompiler, type QueryCompiler, type RootOperationNode } from 'kysely'
import { databaseError, QueryRefusedError } from './errors'
import { assertAllowedTree, type GuardContext } from './guard'
import { isPlainIdentifier } from './identifier'

export type LooseDB = Record<string, Record<string, unknown>>
/** What a statement runs on: the database's own executor, or the one of the transaction it runs in. */
export type Executor = Pick<Kysely<LooseDB>, 'executeQuery'>

/** The SQL a database speaks: Postgres on Bun, SQLite in a Cloudflare Durable Object (ADR-0065). */
export type SqlDialect = 'postgres' | 'sqlite'

export interface TransactionOptions {
	/**
	 * A `READ ONLY` transaction on Postgres. SQLite opens none: each statement runs in a transaction of its own, which
	 * rolls back a statement that wrote. A read-only session refuses writes either way.
	 */
	readonly readOnly: boolean
	/** How long the transaction may sit idle before the database ends it; a database without the setting ignores it. */
	readonly idleTimeoutMs?: number
}

/**
 * Runs `body` in one transaction, on the executor it hands it: commits when `body` resolves, rolls back when it
 * rejects, and rejects with `body`'s error. Its BEGIN, COMMIT and ROLLBACK failures reject with the driver's error.
 */
export type TransactionRunner = <T>(options: TransactionOptions, body: (executor: Executor) => Promise<T>) => Promise<T>

/** What a `Database` runs on: the driver, the compiler of its dialect, and how it opens a transaction. */
export interface DatabaseEngine {
	readonly dialect: SqlDialect
	readonly kysely: Kysely<LooseDB>
	/** Compiles every guarded tree; frozen, since a patch to it after the guard ran would bypass the guard. */
	readonly compiler: QueryCompiler
	readonly transaction: TransactionRunner
	/** The application's schema, the connection's `search_path`; `undefined` where the database has none. */
	readonly schema?: string
}

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

const postgresCompiler = new ParameterCompiler()
freezePrototypeChain(postgresCompiler)

/**
 * The compiler turns the guarded tree into SQL, so a patch to it after the guard ran would bypass the guard.
 * Freezing it when this module loads, before application modules, makes such a patch throw instead.
 */
export function freezePrototypeChain(object: object): void {
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

const SQL_IDLE_TIMEOUT = "select set_config('idle_in_transaction_session_timeout', $1, true)"

/** Postgres over Kysely's own transaction builder. */
function postgresTransaction(kysely: Kysely<LooseDB>): TransactionRunner {
	return (options, body) => {
		const builder = kysely.transaction()
		return (options.readOnly ? builder.setAccessMode('read only') : builder).execute(async (transaction) => {
			if (options.idleTimeoutMs !== undefined) {
				await transaction.executeQuery(CompiledQuery.raw(SQL_IDLE_TIMEOUT, [String(options.idleTimeoutMs)]))
			}
			return body(transaction)
		})
	}
}

let openSession: (database: Database, readOnly: boolean) => Session
let engineOf: (database: Database) => DatabaseEngine
let firstConnection: (database: Database) => Promise<void>

/** The connection the data layer runs on. It has no public query method: everything goes through a store. */
export class Database {
	readonly #engine: DatabaseEngine

	private constructor(engine: DatabaseEngine) {
		if (engine.schema !== undefined && !isPlainIdentifier(engine.schema)) {
			throw new QueryRefusedError('invalid_name', 'the schema must match ^[a-z_][a-z0-9_]*$')
		}
		this.#engine = Object.freeze({ ...engine })
		Object.freeze(this)
	}

	static {
		openSession = (database, readOnly) => new Session(database.#engine.kysely, database.#engine, false, readOnly)
		engineOf = (database) => database.#engine
		firstConnection = async (database) => {
			await database.#engine.kysely.executeQuery(CompiledQuery.raw('SELECT 1'))
		}
	}

	/**
	 * Any Kysely Postgres dialect: `@fabrika/db/postgres` opens Bun.SQL through it, tests use one that records statements
	 * instead of sending them.
	 */
	static fromDialect(dialect: Dialect, options: { readonly schema?: string } = {}): Database {
		const kysely = new Kysely<LooseDB>({ dialect })
		return new Database({ dialect: 'postgres', kysely, compiler: postgresCompiler, transaction: postgresTransaction(kysely), schema: options.schema })
	}

	/** A database of another dialect (`@fabrika/db/sqlite`), with its own frozen compiler and transaction runner. */
	static fromEngine(engine: DatabaseEngine): Database {
		return new Database(engine)
	}

	get dialect(): SqlDialect {
		return this.#engine.dialect
	}

	/** The application's schema, the connection's `search_path`; `undefined` over a bare dialect and on SQLite. */
	get schema(): string | undefined {
		return this.#engine.schema
	}

	async close(): Promise<void> {
		await this.#engine.kysely.destroy()
	}
}
// Application modules load after this one: a replaced opener would receive the database's connection.
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
	readonly #engine: DatabaseEngine
	readonly #inTransaction: boolean
	readonly #readOnly: boolean
	readonly #hooks: SessionHooks

	constructor(executor: Executor, engine: DatabaseEngine, inTransaction: boolean, readOnly: boolean, hooks: SessionHooks = {}) {
		this.#executor = executor
		this.#engine = engine
		this.#inTransaction = inTransaction
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

	/** The dialect of the database this session runs on: a framework statement picks its text by it. */
	get dialect(): SqlDialect {
		return this.#engine.dialect
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
		const compiled: CompiledQuery<O> = this.#engine.compiler.compileQuery(node, createQueryId())
		if (this.#readOnly && !this.#inTransaction) {
			try {
				const result = await this.#engine.transaction({ readOnly: true }, (executor) => executor.executeQuery(compiled))
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
		if (this.#inTransaction) {
			return work(this)
		}
		let open = true
		let failed = false
		let failure: { readonly error: unknown } | undefined
		try {
			return await this.#engine.transaction({ readOnly: this.#readOnly }, async (executor) => {
				try {
					const hooks: SessionHooks = {
						open: () => open,
						failed: () => {
							failed = true
						},
					}
					const result = await untilAborted(work(new Session(executor, this.#engine, true, this.#readOnly, hooks)), signal)
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

/** What the invocation's transaction body throws to roll back; never seen outside this module. */
class RolledBack extends Error {}

/** A writing invocation that holds its object's storage transaction longer than this logs one line. */
export const TRANSACTION_HELD_LOG_MS = 1_000
/** A writing invocation that holds its object's storage transaction longer than this is also reported. */
export const TRANSACTION_HELD_REPORT_MS = 5_000

/** Where an enclosure tells how long it held its object: every other event of the object waited that long. */
export interface HoldWatch {
	/** The site the invocation serves, which the log line names. */
	readonly site: string
	/** Hears a hold longer than `TRANSACTION_HELD_REPORT_MS`, in whole ms. */
	readonly held: (heldMs: number) => void
}

/**
 * Runs once the transaction settled, so it never throws: a failed log or report must not turn a committed invocation
 * into a failed one. Each has its own guard; the line names the site and the ms only, never a value or a statement.
 */
function reportHold(watch: HoldWatch, heldMs: number): void {
	try {
		if (heldMs > TRANSACTION_HELD_LOG_MS) {
			console.warn(`fabrika: ${watch.site}: held its object's transaction for ${heldMs} ms`)
		}
	} catch {
		// The report below still goes out.
	}
	try {
		if (heldMs > TRANSACTION_HELD_REPORT_MS) {
			watch.held(heldMs)
		}
	} catch {
		// The hold was logged; the invocation's own outcome stands.
	}
}

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
	readonly #now: () => number
	readonly #decision = Promise.withResolvers<'commit' | 'rollback'>()
	#opened: Promise<Session> | undefined
	#run: Promise<void> | undefined
	#released: Promise<void> = Promise.resolve()
	#isReleased = true
	#ended = false
	#failed = false
	/** Inside `enclose` on SQLite: `commit()` and `rollback()` only decide, and the enclosure ends the transaction. */
	#enclosed = false
	#decided: 'commit' | 'rollback' | undefined

	/** `now` is the clock an enclosure's hold is measured by. */
	constructor(database: Database, readOnly: boolean, now: () => number = Date.now) {
		this.#database = database
		this.#readOnly = readOnly
		this.#now = now
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

	/**
	 * Runs `work`: the invocation from its handler to its `commit()`. On SQLite a writing invocation's transaction
	 * encloses `work`, opened before it: a Durable Object's transaction holds back every other event, the answers to the
	 * object's own I/O included, until its callback ends, so the handler runs inside it. There `commit()` and `rollback()`
	 * decide, the COMMIT runs once `work` returned, and a failed COMMIT rejects with a `DatabaseError`. A read-only
	 * invocation, and every invocation elsewhere, runs `work` as is: a read-only one on SQLite holds no storage
	 * transaction, so the object serves other events while it awaits.
	 *
	 * Only the SQLite enclosure is measured for `watch`, from entering the transaction until it settled: it holds the
	 * whole object, where a Postgres transaction holds one pooled connection and other requests go on.
	 */
	async enclose<T>(work: () => Promise<T>, watch: HoldWatch): Promise<T> {
		const engine = engineOf(this.#database)
		if (engine.dialect !== 'sqlite' || this.#readOnly) {
			return work()
		}
		if (this.#opened !== undefined || this.#ended) {
			throw new QueryRefusedError('ended', 'an invocation encloses its work before its first statement')
		}
		this.#enclosed = true
		this.#isReleased = false
		let result: { readonly value: T } | undefined
		let entered: number | undefined
		try {
			await engine.transaction({ readOnly: this.#readOnly }, async (executor) => {
				entered = this.#now()
				const session = new Session(executor, engine, true, this.#readOnly, {
					failed: () => {
						this.#failed = true
					},
					open: () => !this.#ended,
				})
				this.#opened = Promise.resolve(session)
				result = { value: await work() }
				this.#ended = true
				if (this.#decided !== 'commit') {
					throw new RolledBack()
				}
			})
		} catch (error) {
			if (result === undefined) {
				throw error
			}
			if (!(error instanceof RolledBack)) {
				throw databaseError(error)
			}
		} finally {
			this.#ended = true
			this.#isReleased = true
			if (entered !== undefined) {
				reportHold(watch, Math.round(this.#now() - entered))
			}
		}
		if (result === undefined) {
			throw new QueryRefusedError('ended', 'the transaction ended before the invocation answered')
		}
		return result.value
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
		const engine = engineOf(this.#database)
		const options: TransactionOptions = { readOnly: this.#readOnly, idleTimeoutMs: INVOCATION_IDLE_TIMEOUT_MS }
		const run = engine.transaction(options, async (executor) => {
			const session = new Session(executor, engine, true, this.#readOnly, {
				failed: () => {
					this.#failed = true
				},
				open: () => !this.#ended,
			})
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
		if (this.#enclosed) {
			this.#decided = this.#failed ? 'rollback' : 'commit'
			if (this.#failed) {
				throw new QueryRefusedError('statement_failed', 'a statement of this invocation failed, so nothing it wrote commits')
			}
			return
		}
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

	/** Discards what the invocation wrote; idempotent, never throws, and returns once the connection is back (inside `enclose`, it only decides). */
	async rollback(): Promise<void> {
		this.#ended = true
		if (this.#enclosed) {
			this.#decided ??= 'rollback'
			return
		}
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
