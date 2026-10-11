// @fabrika/db/testing — the database test kit of an application, for test files only (`@fabrika/check` refuses it
// anywhere else). A test database is a fresh schema with its own role family, migrated by the real runner and used as
// its runtime role; the isolation fixtures seed rows in two disjoint containment chains, and the table probe reaches a
// table by name with every runtime check of a store.

import { applicationRuntimeUrl, definePostgresApplicationMigrations, dropApplicationDatabase } from '@fabrika/platform-node'
import { type ReservedSQL, SQL } from 'bun'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { z } from 'zod/v4'
import { inSet, namesOf } from './builtins'
import { type CatalogColumn, introspectSchema } from './codegen'
import { applicationSchema, Database } from './database'
import type { Primitive } from './description'
import { type Container, modelOf, type TableModel, type TableModels, tableModels, type Tables } from './policy'
import { refuseInProduction } from './production'
import { frameworkSideOf } from './registry'
import type { TableProbe } from './store'

export type { TableProbe } from './store'

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
}

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
	/** The row's values of the policy's update columns, as seeded. */
	readonly updates: Readonly<Record<string, SampleValue>>
	/**
	 * The distinct value written into every text column the fixture filled itself, in this row and in its containers.
	 * Each occurs in no other fixture, so one found in an answer to another scope is a leaked row.
	 */
	readonly markers: readonly string[]
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
	/** Seeds one row of `table` in each of two fresh chains, with every container row a table owns. */
	seedWorlds<DB, P>(tables: Tables<DB, P>, table: string): Promise<IsolationWorlds>
	/** Values for the policy's insert columns of `table` that its schema accepts: every required one, sampled. */
	sampleInsert<DB, P>(tables: Tables<DB, P>, table: string): Promise<Readonly<Record<string, SampleValue>>>
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
	// ISO text, not a Date: the seed binds past the layer's compiler, where Bun.SQL would send Date#toString().
	if (type === 'date' || type === 'timestamp' || type === 'timestamptz') return new Date().toISOString()
	if (type === 'time' || type === 'timetz') return '12:00:00'
	if (type === 'interval') return '1 hour'
	throw new Error(`the isolation fixture cannot fill ${table}.${column.column_name} (${type}); give the column a default or make it nullable`)
}

/** A text column the fixture writes a marker into, nullable or not, so that a leaked value is recognised anywhere. */
function isMarkable(column: CatalogColumn): boolean {
	return column.type_type !== 'e' && TEXT_TYPES.has(column.type_name) && column.generated === 'no'
}

function isRequired(column: CatalogColumn): boolean {
	return !column.nullable && column.generated === 'no'
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
async function reclaimAbandonedSchemas(lock: ReservedSQL, admin: SQL, url: string): Promise<void> {
	const found = nameRows.parse(
		await admin.unsafe(
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
 * A fresh schema with the application's migrations applied by the real runner (`@fabrika/platform-node`) as its
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
		console.warn(`${options.label} skipped: set ${TEST_POSTGRES_URL} to run the Postgres-backed tests`)
		return null
	}
	const appId = `test-${randomHex()}${randomHex()}`
	const schema = applicationSchema(appId)
	const migrations = definePostgresApplicationMigrations({ appId, directory: migrationsDirectory(options.migrations) })
	const runtimeUrl = applicationRuntimeUrl(url, appId)
	const admin = new SQL({ url, adapter: 'postgres', max: 1, prepare: false })
	const holder = new SQL({ url, adapter: 'postgres', max: 1, prepare: false })
	const seeder = new SQL({ url: runtimeUrl, adapter: 'postgres', max: 1, prepare: false })
	const lock = await holder.reserve()
	const releaseLock = async (): Promise<void> => {
		try {
			await lock.unsafe('SELECT pg_advisory_unlock($1::bigint)', [schemaLockKey(schema)])
		} finally {
			lock.release()
		}
	}
	const cleanup = (): Promise<void> =>
		settleAll([() => seeder.close(), () => dropApplicationDatabase(url, appId), releaseLock, () => holder.close(), () => admin.close()])
	try {
		await reclaimAbandonedSchemas(lock, admin, url)
		// Held for the schema's whole life, before the schema and its roles exist: a schema whose lock is free is abandoned.
		await lock.unsafe('SELECT pg_advisory_lock($1::bigint)', [schemaLockKey(schema)])
		await migrations.migrate(url)
	} catch (error) {
		// The roles, the schema and its ledger exist before a failing migration, so a failed start leaves them behind.
		await cleanup()
		throw error
	}
	const database = Database.postgres({ url: runtimeUrl, schema, max: 2 })
	let catalog: Promise<readonly CatalogColumn[]> | undefined

	async function columnsOf(table: string): Promise<readonly CatalogColumn[]> {
		catalog ??= introspectSchema(url, schema, migrations.objects())
		const columns = (await catalog).filter((column) => column.table_name === table)
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
		return column.nullable ? null : sampleOf(table, column)
	}

	/** A value of `dimension` for the column that carries it: a uuid, or text that names the world it belongs to. */
	async function scopeValue(table: string, column: string, dimension: string, world: string): Promise<string> {
		const type = (await columnOf(table, column)).type_name
		if (type === 'uuid') return crypto.randomUUID()
		if (TEXT_TYPES.has(type)) return `${dimension}-${world}-${randomHex()}`
		throw new Error(`${table}.${column} holds a ${dimension} as ${type}; a key or containment column holds its scope value as text or uuid`)
	}

	/** Inserts one row: `assigned` as given, every other required column sampled. Answers what the row holds. */
	async function insert(table: string, assigned: ReadonlyMap<string, Primitive>, markers: string[]): Promise<ReadonlyMap<string, SampleValue>> {
		const row = new Map<string, SampleValue>()
		for (const column of await columnsOf(table)) {
			const value = assigned.get(column.column_name)
			if (value !== undefined) {
				row.set(column.column_name, value)
			} else if (isMarkable(column)) {
				const marker = `m${randomHex()}${randomHex()}`
				markers.push(marker)
				row.set(column.column_name, marker)
			} else if (isRequired(column)) {
				row.set(column.column_name, sampleOf(table, column))
			} else if (column.nullable && column.generated === 'no') {
				row.set(column.column_name, null)
			}
		}
		const names = [...row.keys()]
		const placeholders = names.map((_, index) => `$${index + 1}`)
		await seeder.unsafe(
			`INSERT INTO ${quoted(schema)}.${quoted(table)} (${names.map(quoted).join(', ')}) VALUES (${placeholders.join(', ')})`,
			names.map((name) => row.get(name) ?? null),
		)
		return row
	}

	/** The columns a model's row is placed by: its own key when it owns a dimension, and each link of its chain. */
	function placement(model: TableModel, values: ReadonlyMap<string, string>, key: string): Map<string, Primitive> {
		const assigned = new Map<string, Primitive>()
		const scope = model.scope
		if (scope.mode === 'dimension' || scope.mode === 'child') {
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

	async function seedWorld(models: TableModels, model: TableModel, world: string): Promise<WorldRow> {
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
				await insert(owner.name, placement(owner, values, value), markers)
			}
		}
		const row = await insert(model.name, placement(model, values, key), markers)
		const updates: Record<string, SampleValue> = {}
		for (const name of namesOf(model.update)) {
			updates[name] = row.get(name) ?? await updateSample(model.name, name)
		}
		const dimension = grantDimension(models, model)
		return {
			key,
			parent: scope.mode === 'child' ? (values.get(links[0]?.dimension ?? '') ?? null) : null,
			scope: values.get(dimension) ?? key,
			updates,
			markers,
		}
	}

	return {
		database,
		schema,
		async seedWorlds(tables, table) {
			const { models, model } = scopedModel(tables, table)
			const dimension = grantDimension(models, model)
			return { dimension, own: await seedWorld(models, model, 'own'), other: await seedWorld(models, model, 'other') }
		},
		async sampleInsert(tables, table) {
			const { model } = scopedModel(tables, table)
			const values: Record<string, SampleValue> = {}
			for (const column of await columnsOf(table)) {
				if (inSet(model.insert, column.column_name) && isRequired(column)) {
					values[column.column_name] = sampleOf(table, column)
				}
			}
			return values
		},
		close: () => settleAll([() => database.close(), cleanup]),
	}
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
