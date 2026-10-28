// @fabrika/db/testing — the database test kit of an application, for test files only (`@fabrika/check` refuses it
// anywhere else). A test database is a fresh schema with its own role family, migrated by the real runner and used as
// its runtime role; the isolation fixtures seed rows in two disjoint containment chains, and the table probe reaches a
// table by name with every runtime check of a store.

import {
	applicationRuntimeUrl,
	ConnectionCapacityError,
	DEFAULT_CONNECTION_WAIT_MS,
	definePostgresApplicationMigrations,
	dropApplicationDatabase,
	isConnectionCapacityError,
	withConnectionCapacity,
} from '@fabrika/platform-node'
import { type ReservedSQL, SQL } from 'bun'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { z } from 'zod/v4'
import { type CatalogColumn, introspectSchema } from './codegen'
import { applicationSchema, Database, openFirstConnection } from './database'
import type { Primitive } from './description'
import { HYPERDRIVE_CLIENT_OPTIONS, type HyperdriveClient, openHyperdrive } from './hyperdrive'
import { FILES_TABLE, FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from './migrations'
import { openPostgres, type PostgresOptions } from './postgres'
import { refuseInProduction } from './production'
import type { TableProbe } from './store'
import {
	type CheckConstraint,
	checkLimit,
	foreignKeyLimit,
	type InsertedRow,
	MAX_REMOVED_ROWS,
	probeTable,
	randomHex,
	removalLimit,
	type SeedColumn,
	type SeedingBackend,
	type SeedLimitError,
	type TestDatabase,
	testSeeding,
	typeLimit,
} from './testing-shared'

export { ChildTable, defineChildStore, defineStore, DimensionTable, type TableProbe } from './store'
export {
	type ApplicationRow,
	type IsolationWorlds,
	type SampleValue,
	SEEDED_OBJECT_VERSION,
	type SeededApplicationRows,
	type SeededRow,
	SeedLimitError,
	type TestDatabase,
	type WorldRow,
} from './testing-shared'

const MODULE = '@fabrika/db/testing'
refuseInProduction(MODULE)
const release = process.env['FABRIKA_RELEASE']
if (release !== undefined && release !== '') {
	throw new Error(`${MODULE} is a test helper and does not load in a release (FABRIKA_RELEASE is set)`)
}

export const TEST_POSTGRES_URL = 'FABRIKA_TEST_POSTGRES_URL'
/** Set to `1` by the platform build: a missing test database is then a failure, not a skip. */
export const TEST_POSTGRES_REQUIRED = 'FABRIKA_TEST_POSTGRES_REQUIRED'

export interface TestDatabaseOptions {
	/** The application's `db/migrations/` directory. */
	readonly migrations: string | URL
	/** The test file, for the skip message. */
	readonly label: string
	/**
	 * How long to wait for free connection slots, in ms, before the file fails saying so; `DEFAULT_CONNECTION_WAIT_MS` by
	 * default. Once one file of a process gave up, every later one fails at once.
	 */
	readonly connectionWaitMs?: number
}

/**
 * The driver the runtime role's connections use: Bun.SQL through `openPostgres` by default, or `postgres-js`: postgres.js
 * through `openHyperdrive`, unprepared and without a startup `search_path`, as a Cloudflare Worker reaches Postgres
 * through Hyperdrive. The framework's own suites run once with each, so the two engines answer alike.
 */
export const TEST_POSTGRES_DRIVER = 'FABRIKA_TEST_POSTGRES_DRIVER'

/** The part of a postgres.js client the test kit uses. */
interface PostgresJsClient extends HyperdriveClient {
	end(options?: { readonly timeout?: number }): Promise<void>
}

function isPostgresJsClient(value: unknown): value is PostgresJsClient {
	return typeof value === 'function' && typeof Reflect.get(value, 'reserve') === 'function' && typeof Reflect.get(value, 'end') === 'function'
}

/** Whether `FABRIKA_TEST_POSTGRES_DRIVER` selects postgres.js; any value but the two names is refused. */
function usesPostgresJs(): boolean {
	const driver = process.env[TEST_POSTGRES_DRIVER] ?? ''
	if (driver === '' || driver === 'bun') return false
	if (driver === 'postgres-js') return true
	throw new Error(`${TEST_POSTGRES_DRIVER} must be bun or postgres-js`)
}

/**
 * A postgres.js client opened on its first reservation, so the opener stays synchronous. The module is named by a
 * variable: an application's tests never load postgres.js, and its type checker never resolves it.
 */
function lazyPostgresJs(url: string, options: { readonly max: number; readonly searchPath?: string }): PostgresJsClient {
	let opened: Promise<PostgresJsClient> | undefined
	const open = async (): Promise<PostgresJsClient> => {
		const specifier = 'postgres'
		const loaded: unknown = await import(specifier)
		const factory: unknown = typeof loaded === 'object' && loaded !== null ? Reflect.get(loaded, 'default') : undefined
		if (typeof factory !== 'function') throw new Error('postgres.js has no default export')
		const connection = options.searchPath === undefined ? undefined : { search_path: options.searchPath }
		const client: unknown = factory(url, { ...HYPERDRIVE_CLIENT_OPTIONS, max: options.max, onnotice: () => undefined, connection })
		if (!isPostgresJsClient(client)) throw new Error('postgres.js returned no client')
		return client
	}
	return {
		reserve: async (reserveOptions) => {
			opened ??= open()
			return (await opened).reserve(reserveOptions)
		},
		end: async (endOptions) => {
			if (opened !== undefined) await (await opened).end(endOptions)
		},
	}
}

/**
 * The framework's own suites' connection to a schema they created: `openPostgres`, or with
 * `FABRIKA_TEST_POSTGRES_DRIVER=postgres-js` the Hyperdrive engine over postgres.js. A role without a default search_path
 * (the superuser of a suite's own schema) gets `schema` as a startup parameter there; Hyperdrive would refuse one, which
 * `testDatabase`'s runtime role, whose default it is, never needs. `Database#close()` ends the client either way.
 */
export function openTestPostgres(options: PostgresOptions): Database {
	if (!usesPostgresJs()) return openPostgres(options)
	const client = lazyPostgresJs(options.url, { max: options.max ?? 10, searchPath: options.schema })
	return openHyperdrive({ schema: options.schema, client: () => client, end: () => client.end() })
}

/** The runtime role's database of a test database, through the driver `FABRIKA_TEST_POSTGRES_DRIVER` selects. */
function openRuntimeDatabase(runtimeUrl: string, schema: string): Database {
	if (!usesPostgresJs()) return openPostgres({ url: runtimeUrl, schema, max: RUNTIME_CONNECTIONS })
	const client = lazyPostgresJs(runtimeUrl, { max: RUNTIME_CONNECTIONS })
	return openHyperdrive({ schema, client: () => client, end: () => client.end() })
}

/** Set once a test database of this process gave up waiting for a connection slot. */
let capacityExhausted: ConnectionCapacityError | undefined

const TEXT_TYPES: ReadonlySet<string> = new Set(['text', 'varchar', 'bpchar'])

function quoted(identifier: string): string {
	return `"${identifier}"`
}

/** A sample for a required column the test does not care about, by the types `@fabrika/db/codegen` accepts. */
function sampleOf(table: string, column: CatalogColumn): Primitive {
	if (column.type_type === 'e') {
		const [first] = column.enum_labels
		if (first !== undefined) {
			return first
		}
	}
	const type = column.type_name
	if (type === 'uuid') return crypto.randomUUID()
	if (TEXT_TYPES.has(type)) return `s${randomHex()}`
	if (type === 'int2' || type === 'int4' || type === 'float4' || type === 'float8') return 1
	if (type === 'int8' || type === 'numeric') return '1'
	if (type === 'bool') return false
	// ISO text, not a Date: the seed binds past the layer's compiler, where Bun.SQL would send Date#toString(). A day is
	// `YYYY-MM-DD`, since the probe's insert sends it through the layer, which takes a `date` only so.
	if (type === 'date') return new Date().toISOString().slice(0, 10)
	if (type === 'timestamp' || type === 'timestamptz') return new Date().toISOString()
	if (type === 'time' || type === 'timetz') return '12:00:00'
	if (type === 'interval') return '1 hour'
	throw typeLimit(table, column.column_name, type)
}

/** A catalog column as the seeding reads it. */
function seedColumn(column: CatalogColumn): SeedColumn {
	return {
		table: column.table_name,
		name: column.column_name,
		type: column.type_name,
		nullable: column.nullable,
		defaulted: column.generated !== 'no',
		text: column.type_type !== 'e' && TEXT_TYPES.has(column.type_name),
		uuid: column.type_name === 'uuid',
		sample: () => sampleOf(column.table_name, column),
	}
}

const checkRows = z.array(z.object({ name: z.string(), table_name: z.string(), definition: z.string(), columns: z.array(z.string()) }))

/** Every CHECK constraint of the schema's tables, with its definition as Postgres prints it. */
const CHECK_QUERY = `
SELECT c.conname::text AS name, r.relname::text AS table_name, pg_get_constraintdef(c.oid) AS definition,
	ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) ORDER BY a.attnum) AS columns
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
WHERE n.nspname = $1 AND c.contype = 'c'
ORDER BY r.relname, c.conname
`

const referrerRows = z.array(z.object({ table_name: z.string(), columns: z.array(z.string()), refs: z.array(z.string()) }))

/** Every foreign key of the schema's tables that references the table `$2`, with its columns and the ones it references, in order. */
const REFERRER_QUERY = `
SELECT r.relname::text AS table_name,
	ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS columns,
	ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS refs
FROM pg_constraint c
JOIN pg_class r ON r.oid = c.conrelid
JOIN pg_namespace n ON n.oid = r.relnamespace
JOIN pg_class t ON t.oid = c.confrelid
WHERE n.nspname = $1 AND t.relnamespace = n.oid AND t.relname = $2 AND c.contype = 'f'
ORDER BY r.relname, c.conname
`

// A row's ctid is its place, unique in a table: an application migration creates no partitioned table (ADR-0017).
const ctidRows = z.array(z.object({ ctid: z.string() }))

/** Ctids as one array literal parameter, `{"(0,1)","(0,2)"}`: the driver mis-binds a JS array. */
const tidArray = (ctids: Iterable<string>): string => `{${[...ctids].map((ctid) => `"${ctid}"`).join(',')}}`

/** `CHECK ((status = ANY (ARRAY['open'::text, 'done'::text])))`, a one-column `IN` list as Postgres prints it. */
const IN_LIST = /^CHECK \(\(\(?"?([^"()\s]+)"?\)?(?:::[a-z ]+)? = ANY \(\(?ARRAY\[(.+)\]\)?(?:::[a-z ]+\[\])?\)\)\)$/
const LITERAL = /'((?:[^']|'')*)'::/g

/** The values of a one-column `IN` list, or none for any other CHECK. */
function listedValues(definition: string, columns: readonly string[]): string[] {
	const listed = IN_LIST.exec(definition)
	if (listed === null || columns.length !== 1 || listed[1] !== columns[0]) return []
	return [...(listed[2] ?? '').matchAll(LITERAL)].map((match) => (match[1] ?? '').replaceAll("''", "'"))
}

/** A CHECK or foreign key violation of a seeded row, as the generator limit it is; `undefined` for any other failure. */
function seedLimit(error: unknown, table: string): SeedLimitError | undefined {
	if (!(error instanceof SQL.PostgresError)) return undefined
	const constraint = error.constraint ?? 'unnamed'
	if (error.errno === '23514') return checkLimit(constraint, table)
	if (error.errno === '23503') return foreignKeyLimit(constraint, table)
	return undefined
}

/** The throwaway schemas, `app_test_<16 hex>`, and their roles `app_test_<16 hex>` and `run_test_<16 hex>`; nothing else is ever reclaimed. */
const TEST_SCHEMA = /^app_test_[0-9a-f]{16}$/
const TEST_ROLE = /^(?:app|run)_(test_[0-9a-f]{16})$/
/**
 * Why an abandoned family is left alone: `DROP ROLE` of a role that still owns something in another database of the
 * cluster, and a family another provisioner created (a `test-isolation` run's), which only it administers.
 */
const LEFT_TO_ITS_OWNER: ReadonlySet<unknown> = new Set(['2BP01', '42501'])

/** The session-level advisory lock that holds a throwaway schema: the first 48 bits of SHA-256 of its name, plus one. */
function schemaLockKey(schema: string): string {
	return String(createHash('sha256').update(`fabrika-test-schema:${schema}`, 'utf8').digest().readUIntBE(0, 6) + 1)
}

/** `test-<16 hex>`, the application id whose schema is `app_test_<16 hex>`. */
function testAppId(schema: string): string {
	return `test-${schema.slice('app_test_'.length)}`
}

const nameRows = z.array(z.object({ name: z.string() }))
const lockRows = z.array(z.object({ locked: z.boolean() }))

/**
 * Drops every throwaway schema and role family whose lock can be taken: its run ended without `close` (a crash, a
 * kill). A schema whose lock is held belongs to a live run, perhaps in another process, and is never touched. Roles are
 * the cluster's, so a family whose schema lives in another database, or that another provisioner created, is left to
 * whoever can drop it.
 */
async function reclaimAbandonedSchemas(lock: ReservedSQL, url: string): Promise<void> {
	const found = nameRows.parse(
		await lock.unsafe(
			`SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'app\\_test\\_%' UNION SELECT rolname FROM pg_roles WHERE rolname LIKE 'app\\_test\\_%' OR rolname LIKE 'run\\_test\\_%'`,
		),
	)
	const schemas = new Set<string>()
	for (const { name } of found) {
		const role = TEST_ROLE.exec(name)
		const schema = role === null ? name : `app_${role[1]}`
		if (TEST_SCHEMA.test(schema)) schemas.add(schema)
	}
	for (const schema of schemas) {
		const key = schemaLockKey(schema)
		const [taken] = lockRows.parse(await lock.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS locked', [key]))
		if (taken?.locked !== true) continue
		try {
			await dropApplicationDatabase(url, testAppId(schema))
		} catch (error) {
			if (!(error instanceof SQL.PostgresError && LEFT_TO_ITS_OWNER.has(error.errno))) throw error
		} finally {
			await lock.unsafe('SELECT pg_advisory_unlock($1::bigint)', [key])
		}
	}
}

/** Runs every step even when an earlier one throws, then throws what failed. */
async function settleAll(steps: readonly (() => Promise<void>)[]): Promise<void> {
	const failures: unknown[] = []
	for (const step of steps) {
		try {
			await step()
		} catch (error) {
			failures.push(error)
		}
	}
	if (failures.length === 1) throw failures[0]
	if (failures.length > 1) throw new AggregateError(failures, 'several cleanup steps failed')
}

function migrationsDirectory(migrations: string | URL): string {
	return migrations instanceof URL ? fileURLToPath(migrations) : migrations
}

/**
 * A fresh schema with the framework's and the application's migrations applied by the real runner (`@fabrika/platform-node`) as its
 * migration role, connected and seeded as its runtime role, or `null` after the standard skip message when
 * `FABRIKA_TEST_POSTGRES_URL` is unset. That URL is the provisioning credential, which must be able to create roles.
 * With `FABRIKA_TEST_POSTGRES_REQUIRED=1` a missing URL throws instead. The URL is a credential: no message names it.
 */
export async function testDatabase(options: TestDatabaseOptions): Promise<TestDatabase | null> {
	refuseInProduction(MODULE)
	const url = process.env[TEST_POSTGRES_URL] ?? ''
	if (url === '') {
		if (process.env[TEST_POSTGRES_REQUIRED] === '1') {
			throw new Error(`${options.label}: ${TEST_POSTGRES_REQUIRED}=1, but ${TEST_POSTGRES_URL} is unset`)
		}
		// The Zerops build counts this line's text in every framework release's output: never reword it.
		console.warn(`${options.label} skipped: set ${TEST_POSTGRES_URL} to run the Postgres-backed tests`)
		return null
	}
	if (capacityExhausted !== undefined) throw new Error(`${options.label}: ${capacityExhausted.message}; its cases did not run`)
	const waitMs = options.connectionWaitMs ?? DEFAULT_CONNECTION_WAIT_MS
	let opened: OpenedTestDatabase
	try {
		opened = await withConnectionCapacity(() => openTestDatabase(url, migrationsDirectory(options.migrations)), { waitMs })
	} catch (error) {
		if (!(error instanceof ConnectionCapacityError)) throw error
		// The next file of this run would wait as long again for the same full database.
		capacityExhausted = error
		throw new Error(`${options.label}: ${error.message}; its cases did not run`)
	}
	const { schema, lock, seeder, catalog } = opened
	const referrers = new Map<string, Promise<z.infer<typeof referrerRows>>>()
	/** The foreign keys that reference `table`, read from the catalog once. */
	const referrersOf = (table: string): Promise<z.infer<typeof referrerRows>> => {
		let known = referrers.get(table)
		if (known === undefined) {
			known = lock.unsafe(REFERRER_QUERY, [schema, table]).then((rows: unknown) => referrerRows.parse(rows))
			referrers.set(table, known)
			// A failed read is not kept: the next removal reads the catalog again.
			known.catch(() => referrers.delete(table))
		}
		return known
	}
	/**
	 * Deletes the rows `start` names (table → ctids) and every row that refers to one of them, however deep. Rows are
	 * found a level at a time, one statement per table and foreign key, by joining on the key's columns, so no value
	 * leaves the database and comes back as a parameter. Each found row is locked (`FOR UPDATE`) until the transaction
	 * ends: no write moves it to another ctid, and no new row refers to it, before the delete. All go in one statement,
	 * so rows that refer to each other (a reply its notice pins) go together: a foreign key is checked at its end.
	 */
	const removeRows = async (tx: SQL, start: ReadonlyMap<string, readonly string[]>): Promise<void> => {
		const found = new Map<string, Set<string>>()
		let count = 0
		let level = new Map<string, string[]>()
		const add = (table: string, ctid: string): void => {
			let ctids = found.get(table)
			if (ctids === undefined) {
				ctids = new Set()
				found.set(table, ctids)
			}
			if (ctids.has(ctid)) return
			if (++count > MAX_REMOVED_ROWS) throw removalLimit()
			ctids.add(ctid)
			level.set(table, [...(level.get(table) ?? []), ctid])
		}
		for (const [table, ctids] of start) for (const ctid of ctids) add(table, ctid)
		while (level.size > 0) {
			const current = level
			level = new Map()
			for (const [table, ctids] of current) {
				const target = `${quoted(schema)}.${quoted(table)}`
				for (const key of await referrersOf(table)) {
					const on = key.columns.map((column, position) => `r.${quoted(column)} = t.${quoted(key.refs[position] ?? '')}`).join(' AND ')
					const referring = ctidRows.parse(
						await tx.unsafe(
							`SELECT r.ctid::text AS ctid FROM ${quoted(schema)}.${
								quoted(key.table_name)
							} r JOIN ${target} t ON ${on} WHERE t.ctid = ANY($1::tid[]) FOR UPDATE OF r`,
							[tidArray(ctids)],
						),
					)
					for (const referrer of referring) add(key.table_name, referrer.ctid)
				}
			}
		}
		if (found.size === 0) return
		const tables = [...found]
		const deletes = tables.map(([table], index) =>
			`d${index} AS (DELETE FROM ${quoted(schema)}.${quoted(table)} WHERE ctid = ANY($${index + 1}::tid[]))`
		)
		await tx.unsafe(`WITH ${deletes.join(', ')} SELECT 1`, tables.map(([, ctids]) => tidArray(ctids)))
	}
	const backend: SeedingBackend = {
		columns: catalog.map(seedColumn),
		checks: async () =>
			checkRows.parse(await lock.unsafe(CHECK_QUERY, [schema])).map((row): CheckConstraint => ({
				name: row.name,
				table: row.table_name,
				columns: row.columns,
				values: listedValues(row.definition, row.columns),
			})),
		async insert(table, row) {
			const names = [...row.keys()]
			const placeholders = names.map((_, index) => `$${index + 1}`)
			const target = `${quoted(schema)}.${quoted(table)}`
			const statement = names.length === 0
				? `INSERT INTO ${target} DEFAULT VALUES RETURNING *`
				: `INSERT INTO ${target} (${names.map(quoted).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`
			let stored: unknown
			try {
				stored = await seeder.unsafe(statement, names.map((name) => row.get(name) ?? null))
			} catch (error) {
				throw seedLimit(error, table) ?? error
			}
			const [returned] = z.array(z.record(z.string(), z.unknown())).parse(stored)
			return returned ?? {}
		},
		async firstRow(table, columns) {
			const selected: unknown = await seeder.unsafe(`SELECT ${columns.map(quoted).join(', ')} FROM ${quoted(schema)}.${quoted(table)} LIMIT 1`)
			return z.array(z.record(z.string(), z.unknown())).parse(selected)[0]
		},
		async insertFile(file) {
			await seeder.unsafe(
				`INSERT INTO ${quoted(schema)}.${quoted(FILES_TABLE)} (id, kind, status, object_key, size, sha256, content_type, name, created_at, object_version)
				VALUES ($1, $2, 'live', $3, 0, $4, 'application/octet-stream', 'seeded', now(), $5)`,
				[file.id, file.kind, file.objectKey, file.sha256, file.objectVersion],
			)
		},
		async remove(rows: readonly InsertedRow[]) {
			await seeder.begin(async (tx) => {
				const start = new Map<string, string[]>()
				for (const row of rows) {
					const where = [...row.match.keys()].map((column, index) => `${quoted(column)} = $${index + 1}`).join(' AND ')
					const located = ctidRows.parse(
						await tx.unsafe(`SELECT ctid::text AS ctid FROM ${quoted(schema)}.${quoted(row.table)} WHERE ${where} FOR UPDATE`, [
							...row.match.values(),
						]),
					)
					start.set(row.table, [...(start.get(row.table) ?? []), ...located.map((found) => found.ctid)])
				}
				await removeRows(tx, start)
			})
		},
	}

	return {
		...testSeeding(backend),
		database: opened.database,
		schema,
		// Its own connections end first, so the drop finds a slot even in a database at its limit.
		close: () => closeTestDatabase(url, opened, (drop) => withConnectionCapacity(drop, { waitMs })),
	}
}

/** The pools of one test database; `lock` is absent until its connection is reserved. */
interface TestConnections {
	readonly appId: string
	readonly schema: string
	readonly admin: SQL
	readonly lock: ReservedSQL | undefined
	readonly seeder: SQL
	readonly database: Database
}

/** What `openTestDatabase` holds open for one test file. */
interface OpenedTestDatabase extends TestConnections {
	/** The provisioning credential's one connection: it holds the schema's lock and reads the CHECK constraints. */
	readonly lock: ReservedSQL
	readonly catalog: readonly CatalogColumn[]
}

/** The runtime role's connections of a test database: a job's fenced write and its cancellation each need one. */
const RUNTIME_CONNECTIONS = 2

/**
 * The connections a test database holds once open: the provisioning connection, the seeder and the runtime role's.
 * Migrating and reading the catalog each borrow one more for a moment, and so does the drop once the others ended.
 */
export const TEST_DATABASE_CONNECTIONS = 2 + RUNTIME_CONNECTIONS

/**
 * Creates, locks and migrates a fresh schema and opens the first connection of every pool the test file uses, so no case
 * meets a pool that cannot connect: a refused connection there would read as a failed case. Whatever fails, nothing it
 * opened stays open.
 */
async function openTestDatabase(url: string, directory: string): Promise<OpenedTestDatabase> {
	const appId = `test-${randomHex()}${randomHex()}`
	const schema = applicationSchema(appId)
	// The framework's tables first, as `fabrika db migrate` applies them: a job's lease and a webhook's bindings live there.
	const migrations = definePostgresApplicationMigrations({
		appId,
		directory,
		framework: { bundle: FRAMEWORK_MIGRATION_BUNDLE, migrations: FRAMEWORK_MIGRATIONS },
	})
	const runtimeUrl = applicationRuntimeUrl(url, appId)
	const admin = new SQL({ url, adapter: 'postgres', max: 1, prepare: false })
	const seeder = new SQL({ url: runtimeUrl, adapter: 'postgres', max: 1, prepare: false })
	const database = openRuntimeDatabase(runtimeUrl, schema)
	let lock: ReservedSQL | undefined
	try {
		lock = await admin.reserve()
		await reclaimAbandonedSchemas(lock, url)
		// Held for the schema's whole life, before the schema and its roles exist: a schema whose lock is free is abandoned.
		await lock.unsafe('SELECT pg_advisory_lock($1::bigint)', [schemaLockKey(schema)])
		await migrations.migrate(url)
		const catalog = await introspectSchema(url, schema, migrations.objects())
		await seeder.unsafe('SELECT 1')
		await openFirstConnection(database)
		return { appId, schema, admin, lock, seeder, database, catalog }
	} catch (error) {
		// The roles, the schema and its ledger exist before a failing migration, so a failed start leaves them behind.
		try {
			await closeTestDatabase(url, { appId, schema, admin, lock, seeder, database }, (drop) => drop())
		} catch (cleanupError) {
			// A refused connection is retried with a fresh schema; the next run reclaims this one once its lock is free.
			if (!isConnectionCapacityError(error)) throw cleanupError
		}
		throw error
	}
}

/** Ends every connection of a test database and drops its schema and roles, running each step even when one throws. */
function closeTestDatabase(url: string, connections: TestConnections, dropping: (drop: () => Promise<void>) => Promise<void>): Promise<void> {
	const { appId, schema, admin, lock, seeder, database } = connections
	const releaseLock = async (): Promise<void> => {
		if (lock === undefined) return
		try {
			await lock.unsafe('SELECT pg_advisory_unlock($1::bigint)', [schemaLockKey(schema)])
		} finally {
			lock.release()
		}
	}
	return settleAll([
		() => database.close(),
		() => seeder.close(),
		() => dropping(() => dropApplicationDatabase(url, appId)),
		releaseLock,
		() => admin.close(),
	])
}

/**
 * The untyped handle over one table of the data layer `scoped(tables)` created; it reaches the database once `boot`
 * has bound that layer. Every runtime check of a store applies: kind, dimension, action and the request's authority.
 */
export function tableProbe(layer: unknown, table: string): TableProbe {
	return probeTable(MODULE, layer, table)
}
