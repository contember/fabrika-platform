import { SQL } from 'bun'
import { type CompiledQuery, createQueryId, type Dialect, Kysely, PostgresQueryCompiler, type RootOperationNode } from 'kysely'
import { PostgresJSDialect } from 'kysely-postgres-js'
import { QueryRefusedError } from './errors'
import { assertAllowedTree, type GuardContext } from './guard'
import { isPlainIdentifier } from './identifier'

type LooseDB = Record<string, Record<string, unknown>>
type Executor = Pick<Kysely<LooseDB>, 'executeQuery'>

const compiler = new PostgresQueryCompiler()
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

/** Runs guarded operation trees; the only path from the layer to the connection. */
export class Session {
	readonly #executor: Executor
	readonly #kysely: Kysely<LooseDB> | undefined

	constructor(executor: Executor, kysely: Kysely<LooseDB> | undefined) {
		this.#executor = executor
		this.#kysely = kysely
		Object.freeze(this)
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
