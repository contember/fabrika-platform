import { SQL } from 'bun'
import { CompiledQuery, createQueryId, type Dialect, Kysely, PostgresQueryCompiler, type RootOperationNode } from 'kysely'
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

let openSession: (database: Database) => Session

/** The connection the data layer runs on. It has no public query method: everything goes through a store. */
export class Database {
	readonly #kysely: Kysely<LooseDB>

	private constructor(kysely: Kysely<LooseDB>) {
		this.#kysely = kysely
		Object.freeze(this)
	}

	static {
		openSession = (database) => new Session(database.#kysely, database.#kysely)
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
Object.freeze(Database.prototype)

export function sessionOf(database: Database): Session {
	return openSession(database)
}

let executeFixed: (session: Session, compiled: CompiledQuery) => Promise<readonly unknown[]>

/** Runs guarded operation trees; the only path from the layer to the connection. */
export class Session {
	readonly #executor: Executor
	readonly #kysely: Kysely<LooseDB> | undefined

	constructor(executor: Executor, kysely: Kysely<LooseDB> | undefined) {
		this.#executor = executor
		this.#kysely = kysely
		Object.freeze(this)
	}

	static {
		executeFixed = async (session, compiled) => (await session.#executor.executeQuery(compiled)).rows
	}

	async run<O>(node: RootOperationNode, context: GuardContext): Promise<O[]> {
		assertAllowedTree(node, context)
		// CompiledQuery's row type is a phantom: this is the one place where generated row types meet the wire.
		const compiled: CompiledQuery<O> = compiler.compileQuery(node, createQueryId())
		const result = await this.#executor.executeQuery(compiled)
		return result.rows
	}

	/** Runs `work` in one transaction; inside one, it runs in the transaction already open. */
	async transaction<T>(work: (session: Session) => Promise<T>): Promise<T> {
		if (this.#kysely === undefined) {
			return work(this)
		}
		return this.#kysely.transaction().execute((transaction) => work(new Session(transaction, undefined)))
	}
}
Object.freeze(Session.prototype)

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
