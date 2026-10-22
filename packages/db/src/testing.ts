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
import { inSet, namesOf } from './builtins'
import { type CatalogColumn, introspectSchema } from './codegen'
import { applicationSchema, Database, openFirstConnection } from './database'
import type { Primitive } from './description'
import { FILES_TABLE, FRAMEWORK_MIGRATION_BUNDLE, FRAMEWORK_MIGRATIONS } from './migrations'
import { type Container, type ForeignKey, modelOf, type TableModel, type TableModels, tableModels, type Tables } from './policy'
import { refuseInProduction } from './production'
import { frameworkSideOf } from './registry'
import type { TableProbe } from './store'

export { ChildTable, defineChildStore, defineStore, DimensionTable, type TableProbe } from './store'

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

/** Set once a test database of this process gave up waiting for a connection slot. */
let capacityExhausted: ConnectionCapacityError | undefined

/** A value a test row holds in a column; `null` for a nullable column the fixture left empty. */
export type SampleValue = Primitive | null

/** One seeded row and where it lies. */
export interface WorldRow {
	/** The row's key: the dimension value of a dimension table's row, a child's own key. */
	readonly key: string
	/** A child row's parent key; `null` for a dimension table. */
	readonly parent: string | null
	/** The value of the grant dimension the row lies in (`IsolationWorlds.dimension`). */
	readonly scope: string
	/**
	 * Every dimension value the row lies in: a dimension table's own first, then each container, innermost first. A
	 * share link's chain is this list.
	 */
	readonly chain: readonly { readonly type: string; readonly value: string }[]
	/** The row's values of the policy's update columns, as seeded. */
	readonly updates: Readonly<Record<string, SampleValue>>
	/**
	 * The distinct value written into every text column the fixture filled itself, in this row and in its containers.
	 * Each occurs in no other fixture, so one found in an answer to another scope is a leaked row.
	 */
	readonly markers: readonly string[]
}

/** One seeded row of an application table, which lies in no dimension. */
export interface ApplicationRow {
	readonly key: string
	/** The row's values of the policy's update columns, as seeded. */
	readonly updates: Readonly<Record<string, SampleValue>>
	/** The distinct value written into every text column the fixture filled itself. */
	readonly markers: readonly string[]
}

/** A row seeded under another: its key, and the distinct value written into every text column the fixture filled. */
export interface SeededRow {
	readonly key: string
	readonly markers: readonly string[]
}

/**
 * What the isolation fixture cannot seed for a schema: a CHECK its values fail, a required foreign key to a scoped table
 * outside the containment chain. It is a limit of the generator, named with the constraint or the column, never a
 * failure of the handler or the policy a case is about.
 */
export class SeedLimitError extends Error {
	override readonly name = 'SeedLimitError'
}

/** One row of a table in each of two containment chains that share no value. */
export interface IsolationWorlds {
	/**
	 * The dimension a caller's grants are scoped by: a dimension table's container, or its own dimension when it has
	 * none; a child table's parent's.
	 */
	readonly dimension: string
	readonly own: WorldRow
	readonly other: WorldRow
}

export interface TestDatabase {
	/** The connection `boot` binds the data layer to: the runtime role, on the migrated schema. */
	readonly database: Database
	readonly schema: string
	/**
	 * Seeds one row of `table` in each of two fresh chains, with every container row a table owns. `values` (column →
	 * value) are written into both rows of `table`: the state an endpoint's precondition needs. A text column keeps its
	 * marker, so a seed of one, or of a column that places the row, throws.
	 */
	seedWorlds<DB, P>(tables: Tables<DB, P>, table: string, values?: Readonly<Record<string, SampleValue>>): Promise<IsolationWorlds>
	/** Seeds one row of the application table `table`: its key, version and creator stamped, every other column sampled. */
	seedRow<DB, P>(tables: Tables<DB, P>, table: string): Promise<ApplicationRow>
	/**
	 * Seeds one row of `table`, a child or dimension table that lies in the object of `under` (a row `seedWorlds`
	 * seeded), placed in that row's chain: the row a fixture names by id, such as a note's comment. Answers its key and
	 * the markers it holds.
	 */
	seedUnder<DB, P>(tables: Tables<DB, P>, table: string, under: WorldRow): Promise<SeededRow>
	/** Values for the policy's insert columns of `table` that its schema accepts: every required one, sampled; a file column a seeded file. */
	sampleInsert<DB, P>(tables: Tables<DB, P>, table: string): Promise<Readonly<Record<string, SampleValue>>>
	/**
	 * The object key of every file the fixture seeded into a file column, oldest first. Each stands for an empty object,
	 * which a test's object store holds when a handler serves or opens the file.
	 */
	seededObjects(): readonly string[]
	/** Closes the connections and drops the schema and its roles. */
	close(): Promise<void>
}

const TEXT_TYPES: ReadonlySet<string> = new Set(['text', 'varchar', 'bpchar'])

function randomHex(): string {
	return crypto.randomUUID().replaceAll('-', '').slice(0, 8)
}

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
	throw new SeedLimitError(`the isolation fixture cannot fill ${table}.${column.column_name} (${type}); give the column a default or make it nullable`)
}

/** A text column the fixture writes a marker into, nullable or not, so that a leaked value is recognised anywhere. */
function isMarkable(column: CatalogColumn): boolean {
	return column.type_type !== 'e' && TEXT_TYPES.has(column.type_name) && column.generated === 'no'
}

function isRequired(column: CatalogColumn): boolean {
	return !column.nullable && column.generated === 'no'
}

/** A CHECK constraint of the schema, by the columns it names. */
interface CheckConstraint {
	readonly name: string
	readonly table: string
	readonly columns: readonly string[]
	/** The values of a one-column `IN (…)` list the fixture writes in its place, first one first; empty for any other CHECK. */
	readonly values: readonly string[]
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

/** `CHECK ((status = ANY (ARRAY['open'::text, 'done'::text])))`, a one-column `IN` list as Postgres prints it. */
const IN_LIST = /^CHECK \(\(\(?"?([^"()\s]+)"?\)?(?:::[a-z ]+)? = ANY \(\(?ARRAY\[(.+)\]\)?(?:::[a-z ]+\[\])?\)\)\)$/
const LITERAL = /'((?:[^']|'')*)'::/g

/** The values of a one-column `IN` list, or none for any other CHECK. */
function listedValues(definition: string, columns: readonly string[]): string[] {
	const listed = IN_LIST.exec(definition)
	if (listed === null || columns.length !== 1 || listed[1] !== columns[0]) return []
	return [...(listed[2] ?? '').matchAll(LITERAL)].map((match) => (match[1] ?? '').replaceAll("''", "'"))
}

/** A key value as the database returned it, for the foreign key that references it. */
function keyValue(value: unknown, where: string): SampleValue {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return value
	}
	throw new SeedLimitError(`the isolation fixture cannot reference ${where}: its key is no text, number or boolean`)
}

/** The dimension a caller's grants are scoped by, as `IsolationWorlds.dimension` describes. */
function grantDimension(models: TableModels, model: TableModel): string {
	const scope = model.scope
	if (scope.mode === 'dimension') {
		return scope.container?.dimension ?? scope.dimension
	}
	if (scope.mode === 'child') {
		const parent = modelOf(models, scope.parent)
		if (parent?.scope.mode === 'dimension') {
			return parent.scope.container?.dimension ?? parent.scope.dimension
		}
	}
	throw new Error(`${model.name} is not a dimension or child table; no store reaches it, so it has no isolation tests`)
}

function scopedModel<DB, P>(tables: Tables<DB, P>, table: string): { readonly models: TableModels; readonly model: TableModel } {
	const models = tableModels(tables)
	const model = modelOf(models, table)
	if (model === undefined) {
		throw new Error(`${table} is not a table of the policies`)
	}
	return { models, model }
}

function ownerOf(models: TableModels, dimension: string): TableModel | undefined {
	for (const name of Object.keys(models)) {
		const model = modelOf(models, name)
		if (model?.scope.mode === 'dimension' && model.scope.dimension === dimension) {
			return model
		}
	}
	return undefined
}

/** How many referenced rows deep the fixture follows required foreign keys outside the chain before it gives up. */
const MAX_REFERENCE_DEPTH = 4
/** The digest of the empty object a seeded file stands for. */
const EMPTY_SHA256 = createHash('sha256').digest('hex')

/**
 * The object version a seeded file was scanned at: whoever stocks its empty object (`seededObjects`) stores it under
 * this version, so a file of a scanning kind is served as a live one is, by its scanned version.
 */
export const SEEDED_OBJECT_VERSION = '"seeded"'

/** A CHECK or foreign key violation of a seeded row, as the generator limit it is; `undefined` for any other failure. */
function seedLimit(error: unknown, table: string): SeedLimitError | undefined {
	if (!(error instanceof SQL.PostgresError)) return undefined
	const constraint = error.constraint ?? 'unnamed'
	if (error.errno === '23514') {
		return new SeedLimitError(
			`the isolation fixture cannot satisfy the CHECK ${constraint} of ${table}: it writes a text marker or a sample of the type there; give the column an IN list, a default, or make it nullable`,
		)
	}
	if (error.errno === '23503') {
		return new SeedLimitError(`the isolation fixture's row of ${table} breaks the foreign key ${constraint}`)
	}
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
	let checks: Promise<readonly CheckConstraint[]> | undefined
	const seededObjects: string[] = []

	/** The CHECK constraints that name `column` of `table`. */
	async function checksOn(table: string, column: string): Promise<readonly CheckConstraint[]> {
		checks ??= lock.unsafe(CHECK_QUERY, [schema]).then((rows: unknown) =>
			checkRows.parse(rows).map((row) => ({
				name: row.name,
				table: row.table_name,
				columns: row.columns,
				values: listedValues(row.definition, row.columns),
			}))
		)
		return (await checks).filter((check) => check.table === table && check.columns.includes(column))
	}

	/**
	 * What the fixture writes into a column a CHECK names: the first value of a one-column `IN` list, `null` where the
	 * column admits it (a CHECK passes on null); `undefined` when no CHECK names it or none of those applies.
	 */
	async function checkedValue(table: string, column: CatalogColumn): Promise<SampleValue | undefined> {
		const named = await checksOn(table, column.column_name)
		if (named.length === 0) return undefined
		const [listed] = named.flatMap((check) => check.values)
		if (listed !== undefined && named.every((check) => check.values.includes(listed))) return listed
		return column.nullable ? null : undefined
	}

	/** A required column's sample: an `IN` list's first value where a CHECK names one, else a sample of its type. */
	async function requiredSample(table: string, column: CatalogColumn): Promise<SampleValue> {
		return (await checkedValue(table, column)) ?? sampleOf(table, column)
	}

	async function columnsOf(table: string): Promise<readonly CatalogColumn[]> {
		const columns = catalog.filter((column) => column.table_name === table)
		if (columns.length === 0) {
			throw new Error(`${table} is not a table of the migrated schema; write its migration first`)
		}
		return columns
	}

	async function columnOf(table: string, name: string): Promise<CatalogColumn> {
		const column = (await columnsOf(table)).find((candidate) => candidate.column_name === name)
		if (column === undefined) {
			throw new Error(`${table}.${name} is not a column of the migrated schema`)
		}
		return column
	}

	/** A column the seeded row left to its default: null only where the column admits it. */
	async function updateSample(table: string, name: string): Promise<SampleValue> {
		const column = await columnOf(table, name)
		return column.nullable ? null : requiredSample(table, column)
	}

	/** Whether the fixture writes a marker into `column`: text that holds no foreign key and that no CHECK names. */
	async function holdsMarker(model: TableModel | undefined, table: string, column: CatalogColumn): Promise<boolean> {
		const keyed = (model?.foreignKeys ?? []).some((key) => key.columns.includes(column.column_name))
		return isMarkable(column) && !keyed && (await checksOn(table, column.column_name)).length === 0
	}

	/**
	 * The values of a foreign key outside the containment chain: `null` where every open column admits it, else the
	 * key of a row of the referenced table, an existing one (a reference table's rows come from a migration) or one the
	 * fixture inserts. A required key to a dimension or child table is refused: its row would lie in another chain.
	 */
	async function referencedKey(models: TableModels, table: string, key: ForeignKey, open: readonly string[], depth: number) {
		const columns = await columnsOf(table)
		const values = new Map<string, SampleValue>()
		if (open.every((name) => columns.find((column) => column.column_name === name)?.nullable === true)) {
			for (const name of open) values.set(name, null)
			return values
		}
		const target = modelOf(models, key.table)
		const scoped = target?.scope.mode === 'dimension' || target?.scope.mode === 'child'
		if (scoped || open.length !== key.columns.length || key.table === table || depth >= MAX_REFERENCE_DEPTH) {
			throw new SeedLimitError(
				`the isolation fixture cannot fill ${table}.${
					open.join(', ')
				}: a required foreign key to ${key.table} outside the containment chain; give the column a default or make it nullable`,
			)
		}
		const selected: unknown = await seeder.unsafe(
			`SELECT ${key.references.map(quoted).join(', ')} FROM ${quoted(schema)}.${quoted(key.table)} LIMIT 1`,
		)
		const existing = z.array(z.record(z.string(), z.unknown())).parse(selected)[0]
		const row = existing ?? (await insert(models, key.table, new Map(), [], depth + 1)).stored
		key.columns.forEach((name, index) => {
			const referenced = key.references[index] ?? ''
			values.set(name, keyValue(row[referenced], `${key.table}.${referenced}`))
		})
		return values
	}

	/** A value of `dimension` for the column that carries it: a uuid, or text that names the world it belongs to. */
	async function scopeValue(table: string, column: string, dimension: string, world: string): Promise<string> {
		const type = (await columnOf(table, column)).type_name
		if (type === 'uuid') return crypto.randomUUID()
		if (TEXT_TYPES.has(type)) return `${dimension}-${world}-${randomHex()}`
		throw new Error(`${table}.${column} holds a ${dimension} as ${type}; a key or containment column holds its scope value as text or uuid`)
	}

	/** A live, empty file of `kind`, as the framework's put leaves one once a reference claims it: what a seeded file column holds. */
	async function seedFile(kind: string): Promise<string> {
		const id = crypto.randomUUID()
		const objectKey = `${kind}/${id}`
		seededObjects.push(objectKey)
		await seeder.unsafe(
			`INSERT INTO ${quoted(schema)}.${quoted(FILES_TABLE)} (id, kind, status, object_key, size, sha256, content_type, name, created_at, object_version)
			VALUES ($1, $2, 'live', $3, 0, $4, 'application/octet-stream', 'seeded', now(), $5)`,
			[id, kind, objectKey, EMPTY_SHA256, SEEDED_OBJECT_VERSION],
		)
		return id
	}

	/**
	 * Inserts one row: `assigned` as given, a file column a seeded file, a foreign key outside the chain `null` or referencing a row, a column a CHECK
	 * names its `IN` list's first value or `null`, every other text column a marker and every other required column a
	 * sample. Answers what the fixture wrote, and the row as stored (its database defaults filled). A CHECK or a foreign
	 * key the values still fail is a `SeedLimitError` that names the constraint.
	 */
	async function insert(
		models: TableModels,
		table: string,
		assigned: ReadonlyMap<string, SampleValue>,
		markers: string[],
		depth = 0,
	): Promise<{ readonly row: ReadonlyMap<string, SampleValue>; readonly stored: Readonly<Record<string, unknown>> }> {
		const model = modelOf(models, table)
		const columns = await columnsOf(table)
		// A column with a database default keeps it unless the fixture assigned it, a foreign key's included.
		const defaulted = new Set(columns.filter((column) => column.generated !== 'no').map((column) => column.column_name))
		const keyed = new Map<string, SampleValue>()
		for (const key of model?.foreignKeys ?? []) {
			const open = key.columns.filter((column) => !assigned.has(column) && !defaulted.has(column))
			if (open.length === 0) continue
			for (const [name, value] of await referencedKey(models, table, key, open, depth)) keyed.set(name, value)
		}
		const row = new Map<string, SampleValue>()
		for (const column of columns) {
			const name = column.column_name
			// An assigned `null` is the fixture's value too, never a gap to fill.
			const given = assigned.has(name) ? assigned : keyed.has(name) ? keyed : undefined
			if (given !== undefined) {
				row.set(name, given.get(name) ?? null)
				continue
			}
			if (column.generated !== 'no') continue
			const kind = model !== undefined && Object.hasOwn(model.files, name) ? model.files[name] : undefined
			const checked = kind === undefined ? await checkedValue(table, column) : undefined
			if (kind !== undefined) {
				row.set(name, await seedFile(kind))
			} else if (checked !== undefined) {
				row.set(name, checked)
			} else if (await holdsMarker(model, table, column)) {
				const marker = `m${randomHex()}${randomHex()}`
				markers.push(marker)
				row.set(name, marker)
			} else {
				row.set(name, column.nullable ? null : sampleOf(table, column))
			}
		}
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
		return { row, stored: returned ?? {} }
	}

	/** The columns a model's row is placed by: its own key when it owns a dimension, and each link of its chain. */
	function placement(model: TableModel, values: ReadonlyMap<string, string>, key: string): Map<string, SampleValue> {
		const assigned = new Map<string, SampleValue>()
		const scope = model.scope
		if (scope.mode === 'dimension' || scope.mode === 'child' || scope.mode === 'app') {
			assigned.set(scope.key, key)
		}
		for (const link of model.chain) {
			const value = values.get(link.dimension)
			if (value !== undefined) {
				assigned.set(link.column, value)
			}
		}
		if (model.version !== undefined) {
			assigned.set(model.version, 1)
		}
		if (model.createdBy !== undefined) {
			assigned.set(model.createdBy, 'isolation-fixture')
		}
		return assigned
	}

	async function seedWorld(models: TableModels, model: TableModel, world: string, seed: Readonly<Record<string, SampleValue>>): Promise<WorldRow> {
		const markers: string[] = []
		const values = new Map<string, string>()
		const links: readonly Container[] = model.chain
		for (const link of links) {
			values.set(link.dimension, await scopeValue(model.name, link.column, link.dimension, world))
		}
		const scope = model.scope
		if (scope.mode !== 'dimension' && scope.mode !== 'child') {
			throw new Error(`${model.name} is not a dimension or child table`)
		}
		const key = await scopeValue(model.name, scope.key, scope.mode === 'dimension' ? scope.dimension : model.name, world)
		if (scope.mode === 'dimension') {
			values.set(scope.dimension, key)
		}
		// Containers first, outermost first: a composite foreign key needs its target row.
		for (let index = links.length - 1; index >= 0; index--) {
			const link = links[index]
			const owner = link === undefined ? undefined : ownerOf(models, link.dimension)
			const value = link === undefined ? undefined : values.get(link.dimension)
			if (owner !== undefined && owner.name !== model.name && value !== undefined) {
				await insert(models, owner.name, placement(owner, values, value), markers)
			}
		}
		const assigned = placement(model, values, key)
		for (const [name, value] of Object.entries(seed)) {
			const column = await columnOf(model.name, name)
			if (assigned.has(name)) {
				throw new Error(`${model.name}.${name} places the row in its scope; a seed sets only the row's own state`)
			}
			if (await holdsMarker(model, model.name, column)) {
				throw new Error(
					`${model.name}.${name} holds a text marker the leak cases look for; a seed sets a column of another type (an enum, a boolean, a number), a text column a CHECK lists the values of, or a foreign key`,
				)
			}
			assigned.set(name, value)
		}
		const { row } = await insert(models, model.name, assigned, markers)
		const updates: Record<string, SampleValue> = {}
		for (const name of namesOf(model.update)) {
			updates[name] = row.get(name) ?? await updateSample(model.name, name)
		}
		const dimension = grantDimension(models, model)
		const chain = [
			...(scope.mode === 'dimension' ? [{ type: scope.dimension, value: key }] : []),
			...links.flatMap((link) => {
				const value = values.get(link.dimension)
				return value === undefined ? [] : [{ type: link.dimension, value }]
			}),
		]
		return {
			key,
			parent: scope.mode === 'child' ? (values.get(links[0]?.dimension ?? '') ?? null) : null,
			scope: values.get(dimension) ?? key,
			chain,
			updates,
			markers,
		}
	}

	return {
		database: opened.database,
		schema,
		async seedWorlds(tables, table, values = {}) {
			const { models, model } = scopedModel(tables, table)
			const dimension = grantDimension(models, model)
			return { dimension, own: await seedWorld(models, model, 'own', values), other: await seedWorld(models, model, 'other', values) }
		},
		async seedRow(tables, table) {
			const { models, model } = scopedModel(tables, table)
			if (model.scope.mode !== 'app') {
				throw new Error(`${table} is a ${model.scope.mode} table; seedWorlds seeds a dimension or child table`)
			}
			const markers: string[] = []
			const key = await scopeValue(table, model.scope.key, table, 'app')
			const { row } = await insert(models, table, placement(model, new Map(), key), markers)
			const updates: Record<string, SampleValue> = {}
			for (const name of namesOf(model.update)) {
				updates[name] = row.get(name) ?? await updateSample(table, name)
			}
			return { key, updates, markers }
		},
		async seedUnder(tables, table, under) {
			const { models, model } = scopedModel(tables, table)
			const scope = model.scope
			const [object] = under.chain
			if ((scope.mode !== 'dimension' && scope.mode !== 'child') || object === undefined) {
				throw new Error(`${table} is a ${scope.mode} table; a row seeded under another lies in its chain`)
			}
			const values = new Map(under.chain.map((link) => [link.type, link.value]))
			if (!model.chain.some((link) => link.dimension === object.type) || model.chain.some((link) => !values.has(link.dimension))) {
				throw new Error(`${table} does not lie in a ${object.type}, so no row of it is seeded under one`)
			}
			const key = await scopeValue(table, scope.key, scope.mode === 'dimension' ? scope.dimension : table, 'under')
			const markers: string[] = []
			await insert(models, table, placement(model, values, key), markers)
			return { key, markers }
		},
		async sampleInsert(tables, table) {
			const { models, model } = scopedModel(tables, table)
			const values: Record<string, SampleValue> = {}
			const columns = await columnsOf(table)
			const required = columns.filter((column) => inSet(model.insert, column.column_name) && isRequired(column))
			for (const key of model.foreignKeys) {
				const open = key.columns.filter((name) => required.some((column) => column.column_name === name))
				if (open.length === 0) continue
				for (const [name, value] of await referencedKey(models, table, key, open, 0)) values[name] = value
			}
			for (const column of required) {
				const name = column.column_name
				const kind = Object.hasOwn(model.files, name) ? model.files[name] : undefined
				if (!(name in values)) values[name] = kind === undefined ? await requiredSample(table, column) : await seedFile(kind)
			}
			return values
		},
		seededObjects: () => [...seededObjects],
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
	const database = Database.postgres({ url: runtimeUrl, schema, max: RUNTIME_CONNECTIONS })
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
	refuseInProduction(MODULE)
	const side = frameworkSideOf(layer)
	if (side === undefined) {
		throw new TypeError('not a data layer scoped(tables) created')
	}
	return side.probe(table)
}
