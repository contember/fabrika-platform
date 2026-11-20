// The dialect-neutral half of the database test kits (`@fabrika/db/testing` on Postgres, `@fabrika/db/testing-sqlite`
// on SQLite): the isolation fixtures' shapes, the seeding plan over a migrated schema a kit describes, and the table
// probe. Not a subpath: each kit refuses a production process before it imports this module.

import { createHash } from 'node:crypto'
import { type ApplicationRowRefusal, applicationRowRefusalText, type ApplicationRowsPlan, planApplicationRows } from './application-rows'
import { inSet, namesOf } from './builtins'
import type { Database } from './database'
import type { Primitive } from './description'
import { jsonInput } from './json'
import { FILES_TABLE } from './migrations'
import { type Container, type ForeignKey, modelOf, type TableModel, type TableModels, tableModels, type Tables } from './policy'
import { refuseInProduction } from './production'
import { frameworkSideOf } from './registry'
import type { TableProbe } from './store'

/** A value a test row holds in a column; `null` for a nullable column the fixture left empty. */
export type SampleValue = Primitive | null

/**
 * A seeded value as a backend binds it: a JSON column's value as the JSON text the layer would write for it, so a
 * seeded row and the generated cases that write the same value through the layer hold the same JSON.
 */
export function seedBinding(columns: readonly SeedColumn[], table: string, name: string, value: SampleValue): SampleValue {
	if (value === null || !columns.some((column) => column.table === table && column.name === name && column.json)) return value
	return jsonInput(value, `${table}.${name}`)
}

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
	/**
	 * The values of the text columns of a row the table already held under a known scope value (`seedWorlds`' `scopes`),
	 * which no fixture wrote and other rows may share; empty for a row the fixture inserted.
	 */
	readonly stored: readonly string[]
}

/** One seeded row of an application table, which lies in no dimension. */
export interface ApplicationRow {
	readonly key: string
	/** The row's values of the policy's update columns, as seeded. */
	readonly updates: Readonly<Record<string, SampleValue>>
	/** The distinct value written into every text column the fixture filled itself. */
	readonly markers: readonly string[]
}

/** Rows of application tables seeded together for one case, and their removal once the case is over. */
export interface SeededApplicationRows {
	/** Each table's row key, by table. */
	readonly keys: Readonly<Record<string, string>>
	/**
	 * Deletes the rows, the rows their required foreign keys and file columns made the fixture insert, and every row
	 * that refers to one of them, however deep (what the case's handler wrote about them), in one transaction, so rows
	 * that refer to each other go together. A row already gone is skipped.
	 */
	remove(): Promise<void>
}

/** A row seeded under another: its key, and the distinct value written into every text column the fixture filled. */
export interface SeededRow {
	readonly key: string
	readonly markers: readonly string[]
	/** Deletes the row, the rows its foreign keys made the fixture insert, and every row that refers to them. */
	readonly remove: () => Promise<void>
}

/**
 * What the isolation fixture cannot seed for a schema: a CHECK or a unique index no row it tries passes, a required
 * foreign key whose referenced row it cannot seed. It is a limit of the generator, named with the constraint or the
 * column, never a failure of the handler or the policy a case is about.
 */
export class SeedLimitError extends Error {
	override readonly name = 'SeedLimitError'
}

/** The constraint a seeded row failed, as a backend reads it off the database's error. */
export interface Violation {
	readonly kind: 'check' | 'unique' | 'foreign'
	/** The constraint's name, or for an unnamed CHECK on SQLite its expression, as the database reports it. */
	readonly name: string
	/** The columns the database names (SQLite's unique error); `undefined` where the seeding looks them up by `name`. */
	readonly columns?: readonly string[]
}

/** A seed limit of a row the database refused, with the constraint it failed: the seeding tries another row. */
export class ConstraintLimitError extends SeedLimitError {
	readonly violation: Violation

	constructor(message: string, violation: Violation) {
		super(message)
		this.violation = violation
	}
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
	/**
	 * Deletes both rows of the table it inserted, every container row it inserted when it was given known scope values,
	 * and every row that refers to them, however deep; the other containers stay. A case whose rows hold pinned values or
	 * known scope values removes them, so the next case can seed the same values again under a unique index.
	 */
	readonly remove: () => Promise<void>
}

/**
 * Known values of dimensions, by dimension: the own world's and the other world's, which differ. A dimension whose values
 * are a fixed set (an enum the input names it by) takes these instead of fresh ones.
 */
export type ScopeValues = Readonly<Record<string, { readonly own: string; readonly other: string }>>

/** What a test kit seeds through, over its migrated schema. */
export interface TestSeeding {
	/**
	 * Seeds one row of `table` in each of two fresh chains, with every container row a table owns. `values` (column →
	 * value) are written into both rows of `table`: the state an endpoint's precondition needs. A text column keeps its
	 * marker, so a seed of one, or of a column that places the row, throws. `pins` (column → value) give a text column of
	 * `table` a known value instead of its marker: the value in the own row, and `<value>-other` in the other row, which
	 * counts among the other row's markers, so a leak of it is still found. A pin of a column that places the row, or of
	 * no text column, throws. `scopes` place each world in known values of a dimension instead of fresh ones: a row of
	 * the table that owns it with that key is used as it is stored (a migration wrote it), its containers' values with it,
	 * and is inserted otherwise. A stored row of `table` itself takes no `values` or `pins`: they throw. A seed that throws
	 * removes what it inserted.
	 */
	seedWorlds<DB, P>(
		tables: Tables<DB, P>,
		table: string,
		values?: Readonly<Record<string, SampleValue>>,
		pins?: Readonly<Record<string, string>>,
		scopes?: ScopeValues,
	): Promise<IsolationWorlds>
	/**
	 * Seeds one row of the application table `table`: its key, version and creator stamped, `values` (column → value)
	 * as given, a text column too, every other column sampled. A value for a stamped column or a file column throws.
	 */
	seedRow<DB, P>(tables: Tables<DB, P>, table: string, values?: Readonly<Record<string, SampleValue>>): Promise<ApplicationRow>
	/**
	 * Seeds one row of each application table `rows` names (table → column → value), as `seedRow` does, in foreign-key
	 * order: a foreign key from one of them to another holds that row's key unless the values give it. Every table's
	 * values are checked before the first insert, and a table that fails removes the rows seeded before it. `remove`
	 * deletes them, the rows a required foreign key of theirs made it insert, and every row that refers to any of them,
	 * so the next case starts without them.
	 */
	seedApplicationRows<DB, P>(
		tables: Tables<DB, P>,
		rows: Readonly<Record<string, Readonly<Record<string, SampleValue>>>>,
	): Promise<SeededApplicationRows>
	/**
	 * Seeds one row of `table`, a child or dimension table that lies in the object `under`'s chain starts at (a row
	 * `seedWorlds` seeded, or a value of its chain with the values outside it), placed in that chain: the row a fixture
	 * names by id, such as a note's comment. Answers its key and the markers it holds.
	 */
	seedUnder<DB, P>(tables: Tables<DB, P>, table: string, under: Pick<WorldRow, 'chain'>): Promise<SeededRow>
	/**
	 * Values for the policy's insert columns of `table` that its schema accepts: every required one, sampled; a file
	 * column a seeded file. `beside` is a row `seedWorlds` seeded that the inserted row will lie beside, in the same
	 * containers. A number column a unique index covers takes the next number above the largest the table holds now in the
	 * row's group (the index's other columns as the row will have them, its containers' from `beside`), so insert the
	 * values before taking the next sample, or the two share it.
	 */
	sampleInsert<DB, P>(tables: Tables<DB, P>, table: string, beside?: WorldRow): Promise<Readonly<Record<string, SampleValue>>>
	/**
	 * The object key of every file the fixture seeded into a file column, oldest first. Each stands for an empty object,
	 * which a test's object store holds when a handler serves or opens the file.
	 */
	seededObjects(): readonly string[]
}

export interface TestDatabase extends TestSeeding {
	/** The connection `boot` binds the data layer to: on Postgres the runtime role on the migrated schema; on SQLite the database itself. */
	readonly database: Database
	/** The migrated schema: `app_test_<hex>` on Postgres, `main` on SQLite. */
	readonly schema: string
	/** Closes the connections and drops the schema and its roles (on SQLite: closes the in-memory database). */
	close(): Promise<void>
}

/** A column of the migrated schema, as the seeding reads it. */
export interface SeedColumn {
	readonly table: string
	readonly name: string
	/** The type as the database names it, for a message. */
	readonly type: string
	readonly nullable: boolean
	/** The database fills it when an insert leaves it out: a default, an identity, a generated column. */
	readonly defaulted: boolean
	/** A text type that is no enum: where nothing else fills it, the fixture writes a marker into it. */
	readonly text: boolean
	/** A uuid type: a key or containment column of it holds a random uuid as its scope value. */
	readonly uuid: boolean
	/** A number type: where a unique index covers it, the fixture writes the next number of the row's group instead of its sample. */
	readonly number: boolean
	/** A JSON column (`jsonb`, `JSONB`): its value is a JSON value, bound as the layer binds it (`seedBinding`). */
	readonly json: boolean
	/**
	 * A sample of the column's type for a required column the test does not care about; a `SeedLimitError` for a type it
	 * cannot fill. `variant` 0 is the plain sample; a higher one differs from the lower ones where the type allows (another
	 * day, the other boolean, a larger number), for a unique index whose other columns the row cannot vary.
	 */
	readonly sample: (variant: number) => Primitive
}

/** A CHECK constraint of the schema, by the columns it names. */
export interface CheckConstraint {
	readonly name: string
	readonly table: string
	readonly columns: readonly string[]
	/** The values of a one-column `IN (…)` list the fixture writes in its place, first one first; empty for any other CHECK. */
	readonly values: readonly CheckLiteral[]
	/** Every text and number literal of the expression: what the fixture tries in the columns it names when a row fails it. */
	readonly literals: readonly CheckLiteral[]
}

/** A literal of a CHECK expression. */
export type CheckLiteral = string | number

/**
 * A unique index of the schema (a primary key's or a UNIQUE constraint's included), by its key columns. Only an index of
 * plain columns with no predicate is one: the fixture cannot tell a partial index's rows or an expression's values.
 */
export interface UniqueIndex {
	readonly name: string
	readonly table: string
	readonly columns: readonly string[]
	/** `NULLS NOT DISTINCT`: a null in a key column collides with another row's null there. */
	readonly nullsNotDistinct: boolean
}

/** A live, empty file of `kind`, as the framework's put leaves one once a reference claims it. */
export interface SeededFile {
	readonly id: string
	readonly kind: string
	readonly objectKey: string
	readonly sha256: string
	readonly objectVersion: string
}

/** A row the fixture inserted, found again by `match` (column → value): what a removal deletes. */
export interface InsertedRow {
	readonly table: string
	readonly match: ReadonlyMap<string, SampleValue>
}

/** How many rows one removal deletes, referring rows included, before it gives up. */
export const MAX_REMOVED_ROWS = 10_000

/** The seed limit of a removal that reaches more than `MAX_REMOVED_ROWS` rows. */
export function removalLimit(): SeedLimitError {
	return new SeedLimitError(`the isolation fixture cannot remove the application rows: more than ${MAX_REMOVED_ROWS} rows refer to them`)
}

/** What a kit gives the seeding: its schema's columns and CHECK constraints, and the statements it runs. */
export interface SeedingBackend {
	readonly columns: readonly SeedColumn[]
	/** Every CHECK constraint of the schema's tables; read once, on the first column that needs them. */
	checks(): Promise<readonly CheckConstraint[]>
	/** Every unique index of plain columns and no predicate of the schema's tables; read once, on the first column that needs them. */
	uniqueIndexes(): Promise<readonly UniqueIndex[]>
	/**
	 * The smallest whole number above every value `column` holds in the rows of `table` that match one of `groups`
	 * (`groupsWhere`), and at least 1, as the column's type holds it; `undefined` when the type holds no such number, or
	 * the largest is no finite number.
	 */
	nextNumber(table: string, column: string, groups: readonly ReadonlyMap<string, SampleValue>[]): Promise<Primitive | undefined>
	/**
	 * Inserts one row and answers it as stored; a CHECK, foreign key or unique index it fails is a `SeedLimitError`
	 * (`checkLimit`, `foreignKeyLimit`, `uniqueValueLimit`).
	 */
	insert(table: string, values: ReadonlyMap<string, SampleValue>): Promise<Readonly<Record<string, unknown>>>
	/** One row of `table` that holds `where` (column → value; every row when empty), of `columns`, or `undefined` when none does. */
	firstRow(
		table: string,
		columns: readonly string[],
		where?: ReadonlyMap<string, SampleValue>,
	): Promise<Readonly<Record<string, unknown>> | undefined>
	insertFile(file: SeededFile): Promise<void>
	/**
	 * Deletes `rows` (each found by its `match`; one already gone is skipped) and every row that refers to one of them,
	 * however deep, in one transaction whose foreign keys are checked once all are gone, so rows that refer to each other
	 * go together. No write moves or adds a referring row between finding the rows and deleting them.
	 */
	remove(rows: readonly InsertedRow[]): Promise<void>
}

/** The seed limit of a CHECK a seeded row fails. */
export function checkLimit(constraint: string, table: string): ConstraintLimitError {
	return new ConstraintLimitError(
		`the isolation fixture cannot satisfy the CHECK ${constraint} of ${table}: no row it tried passes it (the values the CHECK names, null where a column admits it, samples of each type, fresh referenced rows)`,
		{ kind: 'check', name: constraint },
	)
}

/** The seed limit of a foreign key a seeded row breaks. */
export function foreignKeyLimit(constraint: string, table: string): ConstraintLimitError {
	return new ConstraintLimitError(`the isolation fixture's row of ${table} breaks the foreign key ${constraint}`, {
		kind: 'foreign',
		name: constraint,
	})
}

/** The seed limit of a number column a unique index covers whose type holds no number above the largest of the row's group. */
export function uniqueLimit(index: string, table: string, column: string): SeedLimitError {
	return new SeedLimitError(
		`the isolation fixture cannot satisfy the unique index ${index} of ${table}: ${column} holds no number above its largest value`,
	)
}

/** The seed limit of a row whose values another row of the table already holds under a unique index. */
export function uniqueValueLimit(index: string, table: string, columns?: readonly string[]): ConstraintLimitError {
	return new ConstraintLimitError(
		`the isolation fixture cannot satisfy the unique index ${index} of ${table}: every row it tried holds values another row holds there (samples of each type, the values a CHECK names, fresh referenced rows)`,
		columns === undefined ? { kind: 'unique', name: index } : { kind: 'unique', name: index, columns },
	)
}

/** The seed limit of a required column whose type the fixture has no sample of. */
export function typeLimit(table: string, column: string, type: string): SeedLimitError {
	return new SeedLimitError(`the isolation fixture cannot fill ${table}.${column} (${type}): it has no sample of that type`)
}

/**
 * A condition that matches a row holding every value of one of `groups` (column → value, `null` matched by `IS NULL`; an
 * empty group matches every row, no group none), in the dialect's quoting and placeholders, with the values it binds.
 */
export function groupsWhere(
	groups: readonly ReadonlyMap<string, SampleValue>[],
	quote: (identifier: string) => string,
	placeholder: (position: number) => string,
): { where: string; values: SampleValue[] } {
	const values: SampleValue[] = []
	const each = groups.map((group) => {
		const terms = [...group].map(([column, value]) => {
			if (value === null) return `${quote(column)} IS NULL`
			values.push(value)
			return `${quote(column)} = ${placeholder(values.length)}`
		})
		return terms.length === 0 ? 'TRUE' : `(${terms.join(' AND ')})`
	})
	return { where: each.length === 0 ? 'FALSE' : each.join(' OR '), values }
}

export function randomHex(): string {
	return crypto.randomUUID().replaceAll('-', '').slice(0, 8)
}

/** The error a refusal of `planApplicationRows` throws when a test seeds the rows anyway. */
function applicationRowError(refusal: ApplicationRowRefusal): Error {
	const text = applicationRowRefusalText(refusal)
	return refusal.kind === 'cycle' ? new SeedLimitError(`the isolation fixture cannot order the application rows: ${text}`) : new Error(text)
}

/** A key value as the database returned it, for the foreign key that references it. */
function keyValue(value: unknown, where: string): SampleValue {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return value
	}
	throw new SeedLimitError(`the isolation fixture cannot reference ${where}: its key is no text, number or boolean`)
}

function isRequired(column: SeedColumn): boolean {
	return !column.nullable && !column.defaulted
}

/** A text column the fixture writes a marker into, nullable or not, so that a leaked value is recognised anywhere. */
function isMarkable(column: SeedColumn): boolean {
	return column.text && !column.defaulted
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
	if (model.view) {
		throw new Error(`${table} is a view, whose rows come from the tables it reads: seed those instead`)
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
const MAX_REFERENCE_DEPTH = 16
/** How many rows the fixture tries for one insert before it reports the last constraint they failed. */
const MAX_ROW_ATTEMPTS = 64
/** How many samples of its type the fixture tries in a column whose values a constraint may refuse. */
const SAMPLE_VARIANTS = 4

/** One way to fill a slot of a row: its values, given the row so far; a `SeedLimitError` when it has none. */
interface SlotOption {
	/** It reads the row's other values (a number a unique index numbers within its group), so it is taken last and never kept. */
	readonly grouped: boolean
	readonly values: (row: ReadonlyMap<string, SampleValue>) => Promise<ReadonlyMap<string, SampleValue>>
}

/** Columns the fixture fills together (one column, or a foreign key's open columns) and the ways it may fill them, first first. */
interface Slot {
	readonly columns: readonly string[]
	readonly options: readonly SlotOption[]
}

/** An option whose values do not depend on the row, computed once: a fresh referenced row is inserted only once. */
function keptOption(compute: () => Promise<ReadonlyMap<string, SampleValue>>): SlotOption {
	let values: Promise<ReadonlyMap<string, SampleValue>> | undefined
	return { grouped: false, values: () => (values ??= compute()) }
}

function valueOption(name: string, value: SampleValue): SlotOption {
	return { grouped: false, values: async () => new Map([[name, value]]) }
}

/** The values a literal of a CHECK suggests for `column`: a number and its neighbours in a number column, a text in a text column. */
function literalValues(column: SeedColumn, literal: CheckLiteral): SampleValue[] {
	if (column.number) return typeof literal === 'number' && Number.isSafeInteger(literal) ? [literal, literal + 1, literal - 1] : []
	return column.text && typeof literal === 'string' ? [literal] : []
}

/** The first usable option of `slot` from `choice[index]` on, which `choice` then records; `undefined` when none is. */
async function pickOption(
	slot: Slot,
	choice: number[],
	index: number,
	row: ReadonlyMap<string, SampleValue>,
): Promise<{ readonly values: ReadonlyMap<string, SampleValue> } | { readonly error: SeedLimitError }> {
	let refused: SeedLimitError | undefined
	for (let at = choice[index] ?? 0; at < slot.options.length; at++) {
		const option = slot.options[at]
		if (option === undefined) continue
		try {
			const values = await option.values(row)
			choice[index] = at
			return { values }
		} catch (error) {
			if (!(error instanceof SeedLimitError)) throw error
			refused = error
		}
	}
	return { error: refused ?? new SeedLimitError('the isolation fixture has no value to try') }
}

/** The next combination of the `involved` slots' options, the first involved changing first; `false` once all were tried. */
function advanceChoice(slots: readonly Slot[], choice: number[], involved: readonly number[]): boolean {
	for (const index of involved) {
		const at = choice[index] ?? 0
		if (at + 1 < (slots[index]?.options.length ?? 0)) {
			choice[index] = at + 1
			return true
		}
		choice[index] = 0
	}
	return false
}
/** The digest of the empty object a seeded file stands for. */
const EMPTY_SHA256 = createHash('sha256').digest('hex')

/**
 * The object version a seeded file was scanned at: whoever stocks its empty object (`seededObjects`) stores it under
 * this version, so a file of a scanning kind is served as a live one is, by its scanned version.
 */
export const SEEDED_OBJECT_VERSION = '"seeded"'

/** The isolation fixtures over the schema `backend` describes. */
export function testSeeding(backend: SeedingBackend): TestSeeding {
	let checks: Promise<readonly CheckConstraint[]> | undefined
	let uniqueIndexes: Promise<readonly UniqueIndex[]> | undefined
	const seededObjects: string[] = []

	/** The CHECK constraints that name `column` of `table`. */
	async function checksOn(table: string, column: string): Promise<readonly CheckConstraint[]> {
		checks ??= backend.checks()
		return (await checks).filter((check) => check.table === table && check.columns.includes(column))
	}

	/**
	 * What the fixture writes into a column a CHECK names: the first value of a one-column `IN` list, `null` where the
	 * column admits it (a CHECK passes on null); `undefined` when no CHECK names it or none of those applies.
	 */
	async function checkedValue(table: string, column: SeedColumn): Promise<SampleValue | undefined> {
		const named = await checksOn(table, column.name)
		if (named.length === 0) return undefined
		const [listed] = named.flatMap((check) => check.values)
		if (listed !== undefined && named.every((check) => check.values.includes(listed))) return listed
		return column.nullable ? null : undefined
	}

	async function uniqueIndexesOf(table: string): Promise<readonly UniqueIndex[]> {
		uniqueIndexes ??= backend.uniqueIndexes()
		return (await uniqueIndexes).filter((index) => index.table === table)
	}

	/** Whether the fixture numbers `column` (`nextNumberOf`) instead of writing its type's sample: a number a unique index covers. */
	async function numbered(table: string, column: SeedColumn): Promise<boolean> {
		return column.number && (await uniqueIndexesOf(table)).some((index) => index.columns.includes(column.name))
	}

	/**
	 * The number a column `numbered` names takes in `row` (column → value, as the row has them so far): the next above the
	 * largest of its group under every unique index that covers it, so the row collides with no row of the table, whoever
	 * wrote it. The group is the rows that hold the index's other columns as `row` does: under a fresh parent it is empty
	 * and the number 1, which a bounded CHECK passes as before. A key column `row` holds no value for yet is left out of
	 * the group, which only widens it; an index the row holds `null` in never conflicts, unless its nulls are not distinct.
	 */
	async function nextNumberOf(
		table: string,
		column: SeedColumn,
		row: ReadonlyMap<string, SampleValue>,
		ungrouped: ReadonlySet<string> = new Set(),
	): Promise<SampleValue> {
		const covering = (await uniqueIndexesOf(table)).filter((index) => index.columns.includes(column.name))
		const groups: Map<string, SampleValue>[] = []
		for (const index of covering) {
			const group = new Map<string, SampleValue>()
			for (const other of index.columns) {
				if (other !== column.name && row.has(other) && !ungrouped.has(other)) group.set(other, row.get(other) ?? null)
			}
			if (index.nullsNotDistinct || ![...group.values()].includes(null)) groups.push(group)
		}
		if (groups.length === 0) return column.sample(0)
		const next = await backend.nextNumber(table, column.name, groups)
		if (next === undefined) throw uniqueLimit(covering.map((index) => index.name).join(', '), table, column.name)
		return next
	}

	/** A required column's sample where the row is not at hand: an `IN` list's first value where a CHECK names one, else a sample of its type. */
	async function requiredSample(table: string, column: SeedColumn): Promise<SampleValue> {
		const checked = await checkedValue(table, column)
		if (checked !== undefined) return checked
		return (await numbered(table, column)) ? nextNumberOf(table, column, new Map()) : column.sample(0)
	}

	function columnsOf(table: string): readonly SeedColumn[] {
		const columns = backend.columns.filter((column) => column.table === table)
		if (columns.length === 0) {
			throw new Error(`${table} is not a table of the migrated schema; write its migration first`)
		}
		return columns
	}

	function columnOf(table: string, name: string): SeedColumn {
		const column = columnsOf(table).find((candidate) => candidate.name === name)
		if (column === undefined) {
			throw new Error(`${table}.${name} is not a column of the migrated schema`)
		}
		return column
	}

	/** A column the seeded row left to its default: null only where the column admits it. */
	async function updateSample(table: string, name: string): Promise<SampleValue> {
		const column = columnOf(table, name)
		return column.nullable ? null : requiredSample(table, column)
	}

	/** Whether the fixture writes a marker into `column`: text that holds no foreign key and that no CHECK names. */
	async function holdsMarker(model: TableModel | undefined, table: string, column: SeedColumn): Promise<boolean> {
		const keyed = (model?.foreignKeys ?? []).some((key) => key.columns.includes(column.name))
		return isMarkable(column) && !keyed && (await checksOn(table, column.name)).length === 0
	}

	/** The open columns of `key` as the referenced row holds them. */
	function keyValues(key: ForeignKey, open: readonly string[], row: Readonly<Record<string, unknown>>): Map<string, SampleValue> {
		const values = new Map<string, SampleValue>()
		key.columns.forEach((name, index) => {
			const referenced = key.references[index] ?? ''
			if (open.includes(name)) values.set(name, keyValue(row[referenced], `${key.table}.${referenced}`))
		})
		return values
	}

	/**
	 * The ways to fill a foreign key outside the containment chain: `null` where every open column admits it, an existing
	 * row of an unscoped table (a reference table's rows come from a migration), and a row the fixture inserts, which
	 * `inserted` records when given. A row of a dimension or child table is always a fresh one: an existing one lies in
	 * another chain. The key's columns the row already holds (a tenant-holding key's ancestors) the referenced row holds too.
	 */
	async function referenceSlot(
		models: TableModels,
		table: string,
		key: ForeignKey,
		open: readonly string[],
		assigned: ReadonlyMap<string, SampleValue>,
		depth: number,
		inserted?: InsertedRow[],
	): Promise<Slot> {
		const columns = columnsOf(table)
		const options: SlotOption[] = []
		if (open.every((name) => columns.find((column) => column.name === name)?.nullable === true)) {
			options.push({ grouped: false, values: async () => new Map(open.map((name) => [name, null])) })
		}
		const fixed = new Map<string, SampleValue>()
		key.columns.forEach((name, index) => {
			if (!open.includes(name)) fixed.set(key.references[index] ?? '', assigned.get(name) ?? null)
		})
		const target = modelOf(models, key.table)
		const scoped = target?.scope.mode === 'dimension' || target?.scope.mode === 'child'
		const refused = key.table === table
			? 'which references its own table'
			: depth >= MAX_REFERENCE_DEPTH
			? `whose referenced rows nest deeper than ${MAX_REFERENCE_DEPTH}`
			: undefined
		if (refused === undefined) {
			if (!scoped) {
				options.push(keptOption(async () => {
					const existing = await backend.firstRow(key.table, key.references, fixed)
					if (existing === undefined) throw new SeedLimitError(`the isolation fixture finds no row of ${key.table} to reference`)
					return keyValues(key, open, existing)
				}))
			}
			options.push(keptOption(async () => keyValues(key, open, await freshRow(models, key, fixed, depth + 1, inserted))))
		}
		if (options.length === 0) {
			throw new SeedLimitError(
				`the isolation fixture cannot fill ${table}.${open.join(', ')}: a required foreign key to ${key.table} outside the containment chain, ${refused}`,
			)
		}
		return { columns: open, options }
	}

	/**
	 * Gives each dimension of `model`'s chain that `values` lacks a fresh value, and inserts the row of each such
	 * container a table owns, outermost first; `inserted` records them when given.
	 */
	async function placeContainers(
		models: TableModels,
		model: TableModel,
		values: Map<string, string>,
		world: string,
		depth: number,
		inserted?: InsertedRow[],
	): Promise<void> {
		for (let index = model.chain.length - 1; index >= 0; index--) {
			const link = model.chain[index]
			if (link === undefined || values.has(link.dimension)) continue
			const value = scopeValue(model.name, link.column, link.dimension, world)
			values.set(link.dimension, value)
			const owner = ownerOf(models, link.dimension)
			if (owner === undefined || owner.name === model.name || owner.scope.mode !== 'dimension') continue
			await insert(models, owner.name, placement(owner, values, value), [], depth, inserted)
			inserted?.push({ table: owner.name, match: new Map([[owner.scope.key, value]]) })
		}
	}

	/**
	 * A fresh row of the table `key` references, holding `fixed` (referenced column → value), as stored. A row of a dimension
	 * or child table lies in the chain `fixed` holds of it, else in fresh values with containers of its own.
	 */
	async function freshRow(
		models: TableModels,
		key: ForeignKey,
		fixed: ReadonlyMap<string, SampleValue>,
		depth: number,
		inserted?: InsertedRow[],
	): Promise<Readonly<Record<string, unknown>>> {
		const target = modelOf(models, key.table)
		const scope = target?.scope
		if (target === undefined || scope === undefined || (scope.mode !== 'dimension' && scope.mode !== 'child')) {
			const { stored } = await insert(models, key.table, fixed, [], depth, inserted)
			inserted?.push({
				table: key.table,
				match: new Map(key.references.map((name) => [name, keyValue(stored[name], `${key.table}.${name}`)])),
			})
			return stored
		}
		if (fixed.has(scope.key)) {
			throw new SeedLimitError(`the isolation fixture cannot insert a row of ${key.table} whose key the referencing row fixes`)
		}
		const values = new Map<string, string>()
		for (const link of target.chain) {
			const value = fixed.get(link.column)
			if (value !== undefined && value !== null) values.set(link.dimension, String(value))
		}
		await placeContainers(models, target, values, 'referenced', depth, inserted)
		const rowKey = scopeValue(target.name, scope.key, scope.mode === 'dimension' ? scope.dimension : target.name, 'referenced')
		const assigned = placement(target, values, rowKey)
		for (const [name, value] of fixed) {
			if (!assigned.has(name)) assigned.set(name, value)
		}
		const { stored } = await insert(models, target.name, assigned, [], depth, inserted)
		inserted?.push({ table: target.name, match: new Map([[scope.key, rowKey]]) })
		return stored
	}

	/** A value of `dimension` for the column that carries it: a uuid, or text that names the world it belongs to. */
	function scopeValue(table: string, name: string, dimension: string, world: string): string {
		const column = columnOf(table, name)
		if (column.uuid) return crypto.randomUUID()
		if (column.text) return `${dimension}-${world}-${randomHex()}`
		throw new Error(`${table}.${name} holds a ${dimension} as ${column.type}; a key or containment column holds its scope value as text or uuid`)
	}

	/**
	 * A live, empty file of `kind`, as the framework's put leaves one once a reference claims it: what a seeded file column
	 * holds. `inserted` records it when given.
	 */
	async function seedFile(kind: string, inserted?: InsertedRow[]): Promise<string> {
		const id = crypto.randomUUID()
		const objectKey = `${kind}/${id}`
		seededObjects.push(objectKey)
		await backend.insertFile({ id, kind, objectKey, sha256: EMPTY_SHA256, objectVersion: SEEDED_OBJECT_VERSION })
		inserted?.push({ table: FILES_TABLE, match: new Map([['id', id]]) })
		return id
	}

	/**
	 * The ways to fill `column`: a file column a seeded file; a column a CHECK names the `IN` list's first value or `null`,
	 * then every value the CHECKs naming it list or compare with, and samples of its type; a text column a marker; any other
	 * nullable column `null`; a number a unique index covers its next number in the row's group; else samples of its type.
	 */
	async function columnSlot(
		model: TableModel | undefined,
		table: string,
		column: SeedColumn,
		markers: string[],
		inserted: InsertedRow[] | undefined,
		ungrouped: ReadonlySet<string>,
	): Promise<Slot> {
		const name = column.name
		const single = (value: SampleValue): ReadonlyMap<string, SampleValue> => new Map([[name, value]])
		const sampled = (variant: number): SlotOption => ({ grouped: false, values: async () => single(column.sample(variant)) })
		const samples = Array.from({ length: SAMPLE_VARIANTS }, (_, variant) => sampled(variant))
		const next: SlotOption = { grouped: true, values: async (row) => single(await nextNumberOf(table, column, row, ungrouped)) }
		const kind = model !== undefined && Object.hasOwn(model.files, name) ? model.files[name] : undefined
		if (kind !== undefined) {
			return {
				columns: [name],
				options: [keptOption(async () => single(await seedFile(kind, inserted))), ...(column.nullable ? [valueOption(name, null)] : [])],
			}
		}
		const named = await checksOn(table, name)
		const isNumbered = await numbered(table, column)
		if (named.length > 0) {
			const checked = await checkedValue(table, column)
			const first = checked === undefined ? (isNumbered ? next : sampled(0)) : valueOption(name, checked)
			const tried: SampleValue[] = column.nullable ? [null] : []
			for (const check of named) {
				for (const literal of [...check.values, ...check.literals]) tried.push(...literalValues(column, literal))
			}
			const listed = [...new Set(tried)].filter((value) => value !== checked).map((value) => valueOption(name, value))
			return { columns: [name], options: [first, ...listed, ...(isNumbered ? [next] : []), ...samples] }
		}
		if (await holdsMarker(model, table, column)) {
			return {
				columns: [name],
				options: [keptOption(async () => {
					const marker = `m${randomHex()}${randomHex()}`
					markers.push(marker)
					return single(marker)
				})],
			}
		}
		if (column.nullable) return { columns: [name], options: [valueOption(name, null)] }
		return { columns: [name], options: isNumbered ? [next] : samples }
	}

	/** The columns of the constraint a row failed, or `undefined` when the seeding cannot tell (an index on an expression). */
	async function violatedColumns(table: string, violation: Violation): Promise<readonly string[] | undefined> {
		if (violation.columns !== undefined) return violation.columns
		if (violation.kind === 'check') {
			checks ??= backend.checks()
			return (await checks).find((check) => check.table === table && check.name === violation.name)?.columns
		}
		return (await uniqueIndexesOf(table)).find((index) => index.name === violation.name)?.columns
	}

	/**
	 * Inserts one row: `assigned` as given, every other column a database default leaves open filled by its slot
	 * (`columnSlot`, `referenceSlot`), each slot's first option first. When the database refuses the row for a CHECK or
	 * a unique index, the fixture tries the next combination of the options of the slots that constraint names (all of
	 * them when it names none it can read), up to `MAX_ROW_ATTEMPTS` rows; the last refusal is the `SeedLimitError`.
	 * Answers what the fixture wrote, and the row as stored (its database defaults filled). `inserted` records every row
	 * a foreign key or a file column made it insert, not the row itself. A number a unique index covers is numbered within
	 * its group without the columns in `ungrouped` (a container the row will not lie in).
	 */
	async function insert(
		models: TableModels,
		table: string,
		assigned: ReadonlyMap<string, SampleValue>,
		markers: string[],
		depth = 0,
		inserted?: InsertedRow[],
		ungrouped: ReadonlySet<string> = new Set(),
	): Promise<{ readonly row: ReadonlyMap<string, SampleValue>; readonly stored: Readonly<Record<string, unknown>> }> {
		const model = modelOf(models, table)
		const columns = columnsOf(table)
		// A column with a database default keeps it unless the fixture assigned it, a foreign key's included.
		const defaulted = new Set(columns.filter((column) => column.defaulted).map((column) => column.name))
		const slots: Slot[] = []
		const slotted = new Set<string>()
		for (const key of model?.foreignKeys ?? []) {
			const open = key.columns.filter((column) => !assigned.has(column) && !defaulted.has(column) && !slotted.has(column))
			if (open.length === 0) continue
			slots.push(await referenceSlot(models, table, key, open, assigned, depth, inserted))
			for (const name of open) slotted.add(name)
		}
		for (const column of columns) {
			// An assigned `null` is the fixture's value too, never a gap to fill.
			if (assigned.has(column.name) || column.defaulted || slotted.has(column.name)) continue
			slots.push(await columnSlot(model, table, column, markers, inserted, ungrouped))
		}
		// A slot that numbers within the row's group is filled once every other slot placed the row.
		const order = [...slots.keys()].sort((left, right) =>
			Number(slots[left]?.options.some((option) => option.grouped)) - Number(slots[right]?.options.some((option) => option.grouped))
		)
		const choice = slots.map(() => 0)
		const involved: number[] = []
		// The refusal of the row the fixture prefers, which the error names once no other row passes.
		let refused: SeedLimitError | undefined
		for (let attempt = 0; attempt < MAX_ROW_ATTEMPTS; attempt++) {
			const row = new Map(assigned)
			let complete = true
			for (const index of order) {
				const slot = slots[index]
				if (slot === undefined) continue
				const picked = await pickOption(slot, choice, index, row)
				if ('error' in picked) {
					// No option of the slot is usable from its current one on: the next combination, or the reason.
					if ((choice[index] ?? 0) === 0 || !involved.includes(index)) throw picked.error
					refused ??= picked.error
					complete = false
					break
				}
				for (const [name, value] of picked.values) row.set(name, value)
			}
			if (complete) {
				try {
					return { row, stored: await backend.insert(table, row) }
				} catch (error) {
					if (!(error instanceof ConstraintLimitError) || error.violation.kind === 'foreign') throw error
					refused ??= error
					const named = await violatedColumns(table, error.violation)
					const touched = [...slots.keys()].filter((index) => named === undefined || (slots[index]?.columns ?? []).some((name) => named.includes(name)))
					// A constraint over the assigned columns only has nothing to try.
					if (touched.length === 0) throw error
					for (const index of touched) {
						if (!involved.includes(index)) involved.push(index)
					}
				}
			}
			if (!advanceChoice(slots, choice, involved)) break
		}
		throw refused ?? new SeedLimitError(`the isolation fixture tried ${MAX_ROW_ATTEMPTS} rows of ${table}`)
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

	/**
	 * The plan of seeding `rows` (table → column → value), after `planApplicationRows`, the rule `@fabrika/check` reports
	 * from source, and the migrated schema passed it: each given column is a column of the database too. Throws the first
	 * refusal; inserts nothing, so a seed of several tables checks them all first.
	 */
	function checkApplicationValues(models: TableModels, rows: Readonly<Record<string, Readonly<Record<string, SampleValue>>>>): ApplicationRowsPlan {
		const plan = planApplicationRows(models, rows)
		const [refusal] = plan.refusals
		if (refusal !== undefined) throw applicationRowError(refusal)
		for (const table of plan.order) {
			for (const name of Object.keys(rows[table] ?? {})) columnOf(table, name)
		}
		return plan
	}

	/**
	 * One row of the application table `model`, whose values `checkApplicationValues` passed: its key, version and
	 * creator stamped, `linked` (a foreign key to a row seeded beside it) and `values` as given, a text column too, every
	 * other column sampled. A key `linked` gives (a table that shares its referenced row's key) is the row's key.
	 * `inserted` records the row and each row a foreign key or a file column made it insert, referenced rows first.
	 */
	async function seedApplicationRow(
		models: TableModels,
		model: TableModel,
		values: Readonly<Record<string, SampleValue>>,
		linked: ReadonlyMap<string, SampleValue>,
		markers: string[],
		inserted?: InsertedRow[],
	) {
		const table = model.name
		const scope = model.scope
		if (scope.mode !== 'app') throw new Error(`${table} is a ${scope.mode} table, not an application table`)
		const shared = linked.get(scope.key)
		const key = shared === undefined || shared === null ? scopeValue(table, scope.key, table, 'app') : String(shared)
		const assigned = placement(model, new Map(), key)
		for (const [name, value] of linked) assigned.set(name, value)
		// A given text column holds no marker: no leak case counts an application row's values as another scope's.
		for (const [name, value] of Object.entries(values)) assigned.set(name, value)
		const seeded = await insert(models, table, assigned, markers, 0, inserted)
		inserted?.push({ table, match: new Map([[scope.key, key]]) })
		return { key, ...seeded }
	}

	/** The value a pin gives the row of `world`: as written in the own row, distinct in the other. */
	const pinnedValue = (value: string, world: string): string => (world === 'own' ? value : `${value}-${world}`)

	/**
	 * The dimension values the row of `owner` keyed `key` lies in, as the table stores it: its own, then each container's;
	 * `undefined` when the table holds no such row.
	 */
	async function storedChain(owner: TableModel, key: string): Promise<ReadonlyMap<string, string> | undefined> {
		const scope = owner.scope
		if (scope.mode !== 'dimension') return undefined
		const row = await backend.firstRow(owner.name, [scope.key, ...owner.chain.map((link) => link.column)], new Map([[scope.key, key]]))
		if (row === undefined) return undefined
		const chain = new Map([[scope.dimension, key]])
		for (const link of owner.chain) chain.set(link.dimension, String(keyValue(row[link.column], `${owner.name}.${link.column}`)))
		return chain
	}

	/**
	 * The dimension values a row of `model` lies in for `world`, as far as `scopes` know them: each known value, and every
	 * value a stored row of a known one holds. `stored` are the dimensions whose row a table holds already.
	 */
	async function knownValues(
		models: TableModels,
		model: TableModel,
		world: 'own' | 'other',
		scopes: ScopeValues,
	): Promise<{ readonly values: Map<string, string>; readonly stored: ReadonlySet<string> }> {
		const own = model.scope.mode === 'dimension' ? [model.scope.dimension] : []
		const dimensions = [...own, ...model.chain.map((link) => link.dimension)].filter((dimension) => Object.hasOwn(scopes, dimension))
		const values = new Map<string, string>()
		for (const dimension of dimensions) {
			const known = scopes[dimension]
			if (known !== undefined) values.set(dimension, world === 'own' ? known.own : known.other)
		}
		const stored = new Set<string>()
		for (const dimension of dimensions) {
			const owner = ownerOf(models, dimension)
			const value = values.get(dimension)
			const chain = owner === undefined || value === undefined ? undefined : await storedChain(owner, value)
			for (const [type, found] of chain ?? []) {
				const expected = values.get(type)
				if (expected !== undefined && expected !== found) {
					throw new Error(`the stored ${dimension} '${value}' lies in the ${type} '${found}', not in the known '${expected}'`)
				}
				values.set(type, found)
				stored.add(type)
			}
		}
		return { values, stored }
	}

	/** The values of the text columns that would hold a marker in the stored row of `model` keyed `key`. */
	async function storedTexts(model: TableModel, key: string): Promise<string[]> {
		const scope = model.scope
		if (scope.mode !== 'dimension') return []
		const names: string[] = []
		for (const column of columnsOf(model.name)) {
			if (await holdsMarker(model, model.name, column)) names.push(column.name)
		}
		if (names.length === 0) return []
		const row = await backend.firstRow(model.name, names, new Map([[scope.key, key]]))
		return names.flatMap((name) => {
			const value = row?.[name]
			return typeof value === 'string' && value !== '' ? [value] : []
		})
	}

	async function seedWorld(
		models: TableModels,
		model: TableModel,
		world: 'own' | 'other',
		seed: Readonly<Record<string, SampleValue>>,
		pins: Readonly<Record<string, string>>,
		scopes: ScopeValues,
		inserted: InsertedRow[],
	): Promise<{ readonly world: Omit<WorldRow, 'updates'>; readonly row: ReadonlyMap<string, SampleValue> }> {
		const markers: string[] = []
		const scope = model.scope
		if (scope.mode !== 'dimension' && scope.mode !== 'child') {
			throw new Error(`${model.name} is not a dimension or child table`)
		}
		const { values, stored } = await knownValues(models, model, world, scopes)
		const links: readonly Container[] = model.chain
		for (const link of links) {
			if (!values.has(link.dimension)) values.set(link.dimension, scopeValue(model.name, link.column, link.dimension, world))
		}
		const own = scope.mode === 'dimension' ? scope.dimension : undefined
		const key = (own === undefined ? undefined : values.get(own)) ?? scopeValue(model.name, scope.key, own ?? model.name, world)
		if (own !== undefined) {
			values.set(own, key)
		}
		const worldRow = (row: ReadonlyMap<string, SampleValue>, stored: readonly string[]) => {
			const chain = [
				...(own === undefined ? [] : [{ type: own, value: key }]),
				...links.flatMap((link) => {
					const value = values.get(link.dimension)
					return value === undefined ? [] : [{ type: link.dimension, value }]
				}),
			]
			const seeded = {
				key,
				parent: scope.mode === 'child' ? (values.get(links[0]?.dimension ?? '') ?? null) : null,
				scope: values.get(grantDimension(models, model)) ?? key,
				chain,
				markers,
				stored,
			}
			return { world: seeded, row }
		}
		if (own !== undefined && stored.has(own)) {
			if (Object.keys(seed).length > 0 || Object.keys(pins).length > 0) {
				throw new Error(
					`${model.name} already holds the ${own} '${key}' (a migration wrote it), so a case writes no seed or pin into it; seed the state of a row the case inserts`,
				)
			}
			return worldRow(new Map(), await storedTexts(model, key))
		}
		// Containers first, outermost first: a composite foreign key needs its target row. A stored one is used as it is.
		for (let index = links.length - 1; index >= 0; index--) {
			const link = links[index]
			const owner = link === undefined ? undefined : ownerOf(models, link.dimension)
			const value = link === undefined ? undefined : values.get(link.dimension)
			if (link === undefined || owner === undefined || owner.name === model.name || value === undefined || stored.has(link.dimension)) continue
			// With known values, every container goes with the worlds: one of a known value, so the next case can insert it
			// again, and one inside a stored row, which no removal of that row reaches.
			const tracked = Object.keys(scopes).length > 0 ? inserted : undefined
			await insert(models, owner.name, placement(owner, values, value), markers, 0, tracked)
			if (tracked !== undefined && owner.scope.mode === 'dimension') {
				tracked.push({ table: owner.name, match: new Map([[owner.scope.key, value]]) })
			}
		}
		const assigned = placement(model, values, key)
		for (const [name, value] of Object.entries(seed)) {
			const column = columnOf(model.name, name)
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
		for (const [name, value] of Object.entries(pins)) {
			const column = columnOf(model.name, name)
			if (assigned.has(name)) {
				throw new Error(`${model.name}.${name} places the row in its scope or is seeded; a pin gives a text column of the row's own state a known value`)
			}
			if (!(await holdsMarker(model, model.name, column))) {
				throw new Error(`${model.name}.${name} holds no text marker; a pin gives a text column a known value, a seed every other column`)
			}
			const pinned = pinnedValue(value, world)
			assigned.set(name, pinned)
			markers.push(pinned)
		}
		const { row } = await insert(models, model.name, assigned, markers, 0, inserted)
		inserted.push({ table: model.name, match: new Map([[scope.key, key]]) })
		return worldRow(row, [])
	}

	/** A seeded row's values of the policy's update columns: as written, or a sample where the database filled the column. */
	async function updatesOf(model: TableModel, row: ReadonlyMap<string, SampleValue>): Promise<Record<string, SampleValue>> {
		const updates: Record<string, SampleValue> = {}
		for (const name of namesOf(model.update)) {
			updates[name] = row.get(name) ?? await updateSample(model.name, name)
		}
		return updates
	}

	return {
		async seedWorlds(tables, table, values = {}, pins = {}, scopes = {}) {
			const { models, model } = scopedModel(tables, table)
			const dimension = grantDimension(models, model)
			for (const [name, known] of Object.entries(scopes)) {
				if (known.own === known.other) throw new Error(`the two worlds share the ${name} '${known.own}'; each needs a value of its own`)
			}
			const inserted: InsertedRow[] = []
			let own: Awaited<ReturnType<typeof seedWorld>>
			let other: Awaited<ReturnType<typeof seedWorld>>
			try {
				own = await seedWorld(models, model, 'own', values, pins, scopes, inserted)
				other = await seedWorld(models, model, 'other', values, pins, scopes, inserted)
			} catch (error) {
				// A row of a known value left behind would pass for one a migration wrote in every later case.
				try {
					await backend.remove(inserted)
				} catch (cleanup) {
					throw new AggregateError([error, cleanup], 'the isolation fixture could not seed the worlds, nor remove what it had seeded')
				}
				throw error
			}
			// Sampled once both rows are written: a number a unique index covers is the next above what the table holds.
			return {
				dimension,
				own: { ...own.world, updates: await updatesOf(model, own.row) },
				other: { ...other.world, updates: await updatesOf(model, other.row) },
				remove: () => backend.remove(inserted),
			}
		},
		async seedRow(tables, table, values = {}) {
			const { models, model } = scopedModel(tables, table)
			checkApplicationValues(models, { [table]: values })
			const markers: string[] = []
			const { key, row } = await seedApplicationRow(models, model, values, new Map(), markers)
			return { key, updates: await updatesOf(model, row), markers }
		},
		async seedApplicationRows(tables, rows) {
			const models = tableModels(tables)
			const plan = checkApplicationValues(models, rows)
			const order = plan.order.flatMap((table) => modelOf(models, table) ?? [])
			const inserted: InsertedRow[] = []
			// Every row the fixture inserted: the given rows, the rows a foreign key or a file column of theirs made it
			// insert, and every row that refers to one of them.
			const remove = (): Promise<void> => backend.remove(inserted)
			const stored = new Map<string, Readonly<Record<string, unknown>>>()
			const keys: Record<string, string> = {}
			try {
				for (const model of order) {
					const values = rows[model.name] ?? {}
					const linked = new Map<string, SampleValue>()
					for (const key of plan.links[model.name] ?? []) {
						const referenced = stored.get(key.table)
						if (referenced === undefined) continue
						key.columns.forEach((column, index) => {
							const name = key.references[index] ?? ''
							linked.set(column, keyValue(referenced[name], `${key.table}.${name}`))
						})
					}
					const seeded = await seedApplicationRow(models, model, values, linked, [], inserted)
					stored.set(model.name, seeded.stored)
					keys[model.name] = seeded.key
				}
			} catch (error) {
				// A table that fails leaves none of the rows seeded before it for the next case.
				try {
					await remove()
				} catch (cleanup) {
					throw new AggregateError([error, cleanup], 'the isolation fixture could not seed the application rows, nor remove those it had seeded')
				}
				throw error
			}
			return { keys, remove }
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
			const key = scopeValue(table, scope.key, scope.mode === 'dimension' ? scope.dimension : table, 'under')
			const markers: string[] = []
			const inserted: InsertedRow[] = []
			await insert(models, table, placement(model, values, key), markers, 0, inserted)
			inserted.push({ table, match: new Map([[scope.key, key]]) })
			return { key, markers, remove: () => backend.remove(inserted) }
		},
		async sampleInsert(tables, table, beside) {
			const { models, model } = scopedModel(tables, table)
			const scope = model.scope
			if (scope.mode !== 'dimension' && scope.mode !== 'child' && scope.mode !== 'app') {
				throw new Error(`${table} is a ${scope.mode} table; no store inserts into it`)
			}
			// A probe row the database judges, placed as the insert will place it (in `beside`'s containers, else in fresh
			// ones it removes with the probe), numbered within the containers known; its values are the sample.
			const values = new Map((beside?.chain ?? []).map((link) => [link.type, link.value]))
			const ungrouped = new Set(model.chain.filter((link) => !values.has(link.dimension)).map((link) => link.column))
			const placed: InsertedRow[] = []
			await placeContainers(models, model, values, 'probe', 0, placed)
			const key = scopeValue(table, scope.key, scope.mode === 'dimension' ? scope.dimension : table, 'probe')
			const { row } = await insert(models, table, placement(model, values, key), [], 0, undefined, ungrouped)
			await backend.remove([{ table, match: new Map([[scope.key, key]]) }, ...placed])
			const sample: Record<string, SampleValue> = {}
			for (const column of columnsOf(table)) {
				if (!inSet(model.insert, column.name) || !row.has(column.name)) continue
				// A nullable column a CHECK ties to another is written as the probe held it; any other is left to the insert.
				if (isRequired(column) || (await checksOn(table, column.name)).length > 0) sample[column.name] = row.get(column.name) ?? null
			}
			return sample
		},
		seededObjects: () => [...seededObjects],
	}
}

/**
 * The untyped handle over one table of the data layer `scoped(tables)` created; it reaches the database once `boot`
 * has bound that layer. Every runtime check of a store applies: kind, dimension, action and the request's authority.
 * `module` is the kit's, which refuses a production process.
 */
export function probeTable(module: string, layer: unknown, table: string): TableProbe {
	refuseInProduction(module)
	const side = frameworkSideOf(layer)
	if (side === undefined) {
		throw new TypeError('not a data layer scoped(tables) created')
	}
	return side.probe(table)
}
