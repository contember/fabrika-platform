import type { Insertable, Selectable, SelectType, Updateable } from 'kysely'
import {
	freeze,
	hasOwn,
	inSet,
	isArray,
	type NameSet,
	nameSet,
	namesOf,
	OBJECT_PROTOTYPE,
	ownDescriptor,
	ownEntry,
	ownKeys,
	ownNames,
	ownSymbols,
	parseList,
	prototypeOf,
	setOwn,
} from './builtins'
import { PolicyError } from './errors'
import { isPlainIdentifier } from './identifier'
import type { Unavailable } from './orm-types'
import type { ColumnTypes, DefineVocabularyPolicies, TableVocabulary } from './vocabulary-tables'

export interface DimensionScope<Col extends string> {
	readonly dimension: string
	readonly key: Col
	readonly in?: { readonly dimension: string; readonly column: Col }
}

export interface ChildScope<Table extends string, Col extends string> {
	readonly child: Table
	readonly key: Col
	readonly column: Col
	readonly inherit: readonly Col[]
}

export interface ReferenceScope {
	readonly reference: string
}

export interface InboxScope<A extends string> {
	readonly inbox: string
	readonly read: A
}

export interface TableActions<A extends string> {
	readonly read: A
	readonly insert?: A
	readonly update?: A
	readonly delete?: A
}

interface WritablePolicy<Col extends string, A extends string, V extends Col> {
	readonly actions: TableActions<A>
	readonly insert?: readonly Col[]
	readonly update?: readonly Col[]
	/** An INTEGER (int4) column: Postgres returns a BIGINT as a string, so it cannot be compared as a number. */
	readonly version?: V
	readonly createdBy?: Col
	readonly columns?: ColumnPolicies<Col, A>
}

/**
 * A column's own read action. Without one, a column falls back to the table's read action. Every read needs the
 * table's read action, so in v1 a column with a different read action is never returned, filtered or sorted by;
 * it can still be written.
 */
export type ColumnPolicies<Col extends string, A extends string> = { readonly [C in Col]?: { readonly read: A } }

export interface DimensionPolicy<Col extends string, A extends string, V extends Col = Col> extends WritablePolicy<Col, A, V> {
	readonly scope: DimensionScope<Col>
}

export interface ChildPolicy<Table extends string, Col extends string, A extends string, V extends Col = Col> extends WritablePolicy<Col, A, V> {
	readonly scope: ChildScope<Table, Col>
}

interface ReadOnlyPolicy<Col extends string, A extends string> {
	readonly insert?: never
	readonly update?: never
	readonly version?: never
	readonly createdBy?: never
	readonly columns?: ColumnPolicies<Col, A>
}

export interface ReferencePolicy<Col extends string, A extends string> extends ReadOnlyPolicy<Col, A> {
	readonly scope: ReferenceScope
	readonly actions: { readonly read: A }
}

export interface InboxPolicy<Col extends string, A extends string> extends ReadOnlyPolicy<Col, A> {
	readonly scope: InboxScope<A>
	readonly actions?: never
}

/** The columns a version can live in: those whose generated select type is `number`, an INTEGER (int4). */
export type VersionColumn<Row> = { [K in keyof Row & string]: SelectType<Row[K]> extends number ? K : never }[keyof Row & string]

/** A foreign key within the schema, as codegen reads it: `columns[i]` references column `references[i]` of `table`. */
export interface ForeignKey<Col extends string = string, Table extends string = string> {
	readonly columns: readonly Col[]
	readonly table: Table
	readonly references: readonly string[]
}

/** One table of the generated column list: its column names, and its foreign keys to tables of the schema. */
export interface TableColumns<Col extends string = string, Table extends string = string> {
	readonly columns: readonly Col[]
	readonly foreignKeys: readonly ForeignKey<Col, Table>[]
}

/** The columns and foreign keys of every table, generated next to the schema types. */
export type ColumnList<DB> = { readonly [T in keyof DB & string]: TableColumns<keyof DB[T] & string, keyof DB & string> }

export interface Container {
	readonly dimension: string
	readonly column: string
}

export type ScopeModel =
	| { readonly mode: 'dimension'; readonly dimension: string; readonly key: string; readonly container: Container | undefined }
	| { readonly mode: 'child'; readonly parent: string; readonly key: string; readonly column: string; readonly inherit: readonly string[] }
	| { readonly mode: 'reference'; readonly reason: string }
	| { readonly mode: 'inbox'; readonly form: string }

export interface ActionModel {
	readonly read: string
	readonly insert: string | undefined
	readonly update: string | undefined
	readonly delete: string | undefined
}

/** One table's policy, checked against its column list. */
export interface TableModel {
	readonly name: string
	readonly scope: ScopeModel
	readonly actions: ActionModel
	/** Every column the table has. */
	readonly columns: NameSet
	/** The columns the table's read action reads, in column-list order. */
	readonly visible: readonly string[]
	readonly insert: NameSet
	readonly update: NameSet
	readonly version: string | undefined
	readonly createdBy: string | undefined
	/** The columns that declare their own read action, as declared (also those equal to the table's). */
	readonly columnReads: Readonly<Record<string, string>>
	/** The table's foreign keys, from the column list; a containment column must be one to its container's key. */
	readonly foreignKeys: readonly ForeignKey[]
	/**
	 * The containment links this table carries a column for, nearest first: a dimension table's container and
	 * the container's own chain; a child's parent and the parent's chain. Every predicate of a Ref covers all.
	 */
	readonly chain: readonly Container[]
}

/** A child's `column` and `inherit`, when omitted, are derived from its parent while the tables are linked. */
type ParsedScope =
	| Exclude<ScopeModel, { readonly mode: 'child' }>
	| {
		readonly mode: 'child'
		readonly parent: string
		readonly key: string
		readonly column: string | undefined
		readonly inherit: readonly string[] | undefined
	}

type ParsedTable = Omit<TableModel, 'chain' | 'scope'> & { readonly scope: ParsedScope }

let readModels: <DB, P>(tables: Tables<DB, P>) => TableModels
let hasModels: (value: object) => boolean = () => false

/** Every table's model by name; read it through `modelOf`, never by a plain property access. */
export type TableModels = Readonly<Record<string, TableModel>>

/** The validated policies of every table; carries the schema and the literal policy types to the store. */
export class Tables<DB, P> {
	readonly #models: TableModels
	readonly #types: { readonly db?: (db: DB) => DB; readonly policies?: (policies: P) => P } = {}

	constructor(models: TableModels) {
		this.#models = models
	}

	static {
		readModels = (tables) => tables.#models
		hasModels = (value) => #models in value
	}
}
Object.freeze(Tables.prototype)

export function tableModels<DB, P>(tables: Tables<DB, P>): TableModels {
	return readModels(tables)
}

/** Whether `value` is what `defineTables` returned, rather than another form of the same policies. */
export function isTables<DB, P, Other extends object>(value: Tables<DB, P> | Other): value is Tables<DB, P> {
	return hasModels(value)
}

export function modelOf(models: TableModels, table: string): TableModel | undefined {
	return ownEntry(models, table)
}

/**
 * Declares the access policy of every table, under the application's vocabulary:
 * `defineTables(vocabulary, columns)({ notes: { scope: …, actions: … }, … })`. `columns` is the generated column list,
 * which carries the schema's row types; a list without them makes the policies uncallable. The action and dimension
 * names are the vocabulary's, and each table's containment comes from it: a key defaults to `id`, a container column
 * to `<container>_id`, a child's column to `<parent dimension>_id`, and its inherited chain is its parent's.
 */
export function defineTables<const V extends TableVocabulary, C extends object>(vocabulary: V, columns: C): VocabularyTables<V, C>
export function defineTables<DB, P>(vocabularyInput: unknown, columns: unknown): (policies: P) => Tables<DB, P> {
	if (columns === undefined) {
		throw new PolicyError('defineTables takes the vocabulary and the generated column list: defineTables(vocabulary, columns)({ … })')
	}
	const vocabulary = parseVocabulary(vocabularyInput)
	return (policies) => new Tables(parseTables(columns, policies, vocabulary))
}

/** `defineTables(vocabulary, columns)` answers the policies' builder, or names the fix for an untyped column list. */
export type VocabularyTables<V, C> = [ColumnTypes<C>] extends [never]
	? Unavailable<'the column list carries no row types: import columns from the generated src/db/schema.generated.ts (fabrika db codegen)'>
	: DefineVocabularyPolicies<ColumnTypes<C>, V>

/**
 * The same policies read from values nobody type-checked: `src/db/tables.ts` and its vocabulary as the static reader
 * has them from a commit. Every shape `defineTables` refuses at runtime is refused here, through the same parse.
 */
export function readTables(columns: unknown, policies: unknown, vocabulary: unknown): Tables<unknown, unknown> {
	return new Tables(parseTables(columns, policies, parseVocabulary(vocabulary)))
}

/** Each dimension of the vocabulary, by name, with the dimension it lies in (`undefined` for a top-level one). */
type Containment = Readonly<Record<string, { readonly container: string | undefined }>>

/** What the parse reads of the vocabulary: its containment and its action names; its roles are the contract's. */
interface VocabularyModel {
	readonly dimensions: Containment
	readonly actions: NameSet
}

function parseVocabulary(input: unknown): VocabularyModel {
	const vocabulary = plainRecord(input, 'the vocabulary')
	const dimensions = plainRecord(ownEntry(vocabulary, 'dimensions'), 'the vocabulary dimensions')
	const names = ownKeys(dimensions)
	const containment: Record<string, { readonly container: string | undefined }> = {}
	for (let index = 0; index < names.length; index++) {
		const name = names[index] ?? ''
		const container = ownEntry(plainRecord(ownEntry(dimensions, name), `the vocabulary dimension ${name}`), 'in')
		if (container !== undefined && (typeof container !== 'string' || !hasOwn(dimensions, container))) {
			throw new PolicyError(`the vocabulary puts ${name} in ${String(container)}, which is not one of its dimensions`)
		}
		setOwn(containment, name, freeze({ container }))
	}
	for (let index = 0; index < names.length; index++) {
		const path = [names[index] ?? '']
		for (let above = ownEntry(containment, path[0] ?? '')?.container; above !== undefined; above = ownEntry(containment, above)?.container) {
			path[path.length] = above
			if (above === path[0] || path.length > names.length) {
				throw new PolicyError(`the vocabulary's containment is a cycle (${path.join(' → ')})`)
			}
		}
	}
	const actions = ownKeys(plainRecord(ownEntry(vocabulary, 'actions'), 'the vocabulary actions'))
	return freeze({ dimensions: freeze(containment), actions: nameSet(actions) })
}

const COLUMN_LIST_FIELDS = nameSet(['columns', 'foreignKeys'])
const FOREIGN_KEY_FIELDS = nameSet(['columns', 'table', 'references'])
const POLICY_FIELDS = nameSet(['scope', 'actions', 'insert', 'update', 'version', 'createdBy', 'columns'])
const ACTION_FIELDS = nameSet(['read', 'insert', 'update', 'delete'])
const DIMENSION_FIELDS = nameSet(['dimension', 'key', 'in'])
const CONTAINER_FIELDS = nameSet(['dimension', 'column'])
const CHILD_FIELDS = nameSet(['child', 'key', 'column', 'inherit'])
const REFERENCE_FIELDS = nameSet(['reference'])
const INBOX_FIELDS = nameSet(['inbox', 'read'])
const COLUMN_FIELDS = nameSet(['read'])

/** A copy of a plain object's own data properties; anything else (an instance, a symbol key, an accessor) is refused. */
function plainRecord(value: unknown, what: string): Readonly<Record<string, unknown>> {
	const prototype: unknown = typeof value === 'object' && value !== null && !isArray(value) ? prototypeOf(value) : undefined
	if ((prototype !== OBJECT_PROTOTYPE && prototype !== null) || typeof value !== 'object' || value === null || ownSymbols(value).length > 0) {
		throw new PolicyError(`${what} must be a plain object`)
	}
	const copy: Record<string, unknown> = {}
	const keys = ownNames(value)
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		const descriptor = ownDescriptor(value, key)
		if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
			throw new PolicyError(`${what}: ${key} is an accessor; a policy holds plain values`)
		}
		setOwn(copy, key, descriptor.value)
	}
	return freeze(copy)
}

/** Unknown keys are refused, not dropped: a misspelt `insrt` would otherwise leave the table without its column list. */
function onlyFields(record: Readonly<Record<string, unknown>>, allowed: NameSet, what: string): void {
	const keys = ownKeys(record)
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		if (!inSet(allowed, key)) {
			throw new PolicyError(`${what}: ${key} is not a field here (allowed: ${namesOf(allowed).join(', ')})`)
		}
	}
}

function parseTables(columnsInput: unknown, policiesInput: unknown, vocabulary: VocabularyModel): TableModels {
	const columns = plainRecord(columnsInput, 'the column list')
	const policies = plainRecord(policiesInput, 'the table policies')
	const tables = ownKeys(columns)
	const policyTables = ownKeys(policies)
	for (let index = 0; index < policyTables.length; index++) {
		const table = policyTables[index] ?? ''
		if (!hasOwn(columns, table)) {
			throw new PolicyError(`${table}: no such table in the column list (tables: ${tables.join(', ')})`)
		}
	}
	const parsed: ParsedTable[] = []
	for (let index = 0; index < tables.length; index++) {
		const table = tables[index] ?? ''
		const policy = ownEntry(policies, table)
		if (policy === undefined) {
			throw new PolicyError(`${table}: every table needs a policy in tables.ts`)
		}
		parsed[index] = parseTable(table, ownEntry(columns, table), policy, vocabulary)
	}
	return linkTables(parsed, vocabulary.dimensions)
}

/** How a policy names its columns: one it states must exist, and so must one a convention derives for it. */
interface ColumnReader {
	readonly column: (name: unknown, field: string) => string
	readonly columnsOf: (value: unknown, field: string) => string[]
	/** `name` is what `field` defaults to, for `reason`; when the table has no such column, the policy states `fix`. */
	readonly derived: (name: string, field: string, reason: string, fix: string) => string
}

function parseTable(table: string, columnList: unknown, policyInput: unknown, vocabulary: VocabularyModel): ParsedTable {
	if (!isPlainIdentifier(table)) {
		throw new PolicyError(`${table}: a table name must match ^[a-z_][a-z0-9_]*$`)
	}
	const policy = plainRecord(policyInput, `${table}: the policy`)
	onlyFields(policy, POLICY_FIELDS, `${table}: the policy`)
	const entry = plainRecord(columnList, `${table}: the column list entry`)
	onlyFields(entry, COLUMN_LIST_FIELDS, `${table}: the column list entry`)
	const columnNames = parseList(ownEntry(entry, 'columns'), (name) => {
		if (!isPlainIdentifier(name)) {
			throw new PolicyError(`${table}.${String(name)}: a column name must match ^[a-z_][a-z0-9_]*$`)
		}
		return name
	})
	if (columnNames === undefined) {
		throw new PolicyError(`${table}: the column list takes a plain array of column names`)
	}
	const columns = nameSet(columnNames)
	const column = (name: unknown, field: string): string => {
		if (!inSet(columns, name)) {
			throw new PolicyError(`${table}: ${field} names ${String(name)}, which is not a column (columns: ${columnNames.join(', ')})`)
		}
		return name
	}
	const columnsOf = (value: unknown, field: string): string[] => {
		if (value === undefined) {
			return []
		}
		const names = parseList(value, (name) => column(name, field))
		if (names === undefined) {
			throw new PolicyError(`${table}: ${field} takes a plain array of column names`)
		}
		return names
	}
	const derived = (name: string, field: string, reason: string, fix: string): string => {
		if (!inSet(columns, name)) {
			throw new PolicyError(
				`${table}: ${field} defaults to ${name} (${reason}), which is not a column; state ${fix} (columns: ${columnNames.join(', ')})`,
			)
		}
		return name
	}
	const scopeInput = plainRecord(ownEntry(policy, 'scope'), `${table}: scope`)
	const foreignKeys = parseForeignKeys(table, ownEntry(entry, 'foreignKeys'), column)
	const scope = parseScope(table, scopeInput, { column, columnsOf, derived }, vocabulary.dimensions)
	const action = (value: unknown, field: string): string => {
		const name = nonEmpty(table, value, field)
		if (!inSet(vocabulary.actions, name)) {
			throw new PolicyError(
				`${table}: ${field} names ${name}, which is not an action of the vocabulary (actions: ${namesOf(vocabulary.actions).join(', ')})`,
			)
		}
		return name
	}
	const actions = parseActions(table, scopeInput, ownEntry(policy, 'actions'), action)
	const insert = nameSet(columnsOf(ownEntry(policy, 'insert'), 'insert'))
	const update = nameSet(columnsOf(ownEntry(policy, 'update'), 'update'))
	const versionInput = ownEntry(policy, 'version')
	const createdByInput = ownEntry(policy, 'createdBy')
	const version = versionInput === undefined ? undefined : column(versionInput, 'version')
	const createdBy = createdByInput === undefined ? undefined : column(createdByInput, 'createdBy')
	const restricted: string[] = []
	const columnReads: Record<string, string> = {}
	const columnsInput = ownEntry(policy, 'columns')
	const columnPolicies = columnsInput === undefined ? freeze({}) : plainRecord(columnsInput, `${table}: columns`)
	const restrictable = ownKeys(columnPolicies)
	for (let index = 0; index < restrictable.length; index++) {
		const name = column(restrictable[index], 'columns')
		const columnPolicy = plainRecord(ownEntry(columnPolicies, name), `${table}: columns.${name}`)
		onlyFields(columnPolicy, COLUMN_FIELDS, `${table}: columns.${name}`)
		const read = action(ownEntry(columnPolicy, 'read'), `columns.${name}.read`)
		setOwn(columnReads, name, read)
		if (read !== actions.read) {
			restricted[restricted.length] = name
		}
	}
	const hidden = nameSet(restricted)

	// Every capability reads the key and the version: a page is ordered by the key, and a write answers both.
	if ((scope.mode === 'dimension' || scope.mode === 'child') && hasOwn(columnReads, scope.key)) {
		throw new PolicyError(`${table}: the key ${scope.key} takes no read action of its own`)
	}
	if (version !== undefined && hasOwn(columnReads, version)) {
		throw new PolicyError(`${table}: the version ${version} takes no read action of its own`)
	}
	const writable = scope.mode === 'dimension' || scope.mode === 'child'
	if (!writable && (namesOf(insert).length > 0 || namesOf(update).length > 0 || version !== undefined || createdBy !== undefined)) {
		throw new PolicyError(`${table}: a ${scope.mode} table is never written by a handler`)
	}
	const visible: string[] = []
	for (let index = 0; index < columnNames.length; index++) {
		const name = columnNames[index] ?? ''
		if (!inSet(hidden, name)) {
			visible[visible.length] = name
		}
	}
	return {
		name: table,
		scope,
		actions,
		columns,
		visible: freeze(visible),
		insert,
		update,
		version,
		createdBy,
		columnReads: freeze(columnReads),
		foreignKeys,
	}
}

/** The table's foreign keys, each column one of its own; the referenced side is checked once every table is parsed. */
function parseForeignKeys(table: string, input: unknown, column: (name: unknown, field: string) => string): readonly ForeignKey[] {
	const keys = parseList(input, (item) => {
		const key = plainRecord(item, `${table}: a foreign key`)
		onlyFields(key, FOREIGN_KEY_FIELDS, `${table}: a foreign key`)
		const columns = parseList(ownEntry(key, 'columns'), (name) => column(name, 'a foreign key'))
		const references = parseList(ownEntry(key, 'references'), (name) => nonEmpty(table, name, 'a foreign key reference'))
		if (columns === undefined || references === undefined || columns.length === 0 || columns.length !== references.length) {
			throw new PolicyError(`${table}: a foreign key takes columns and references, two plain arrays of one length`)
		}
		return freeze({ columns: freeze(columns), table: nonEmpty(table, ownEntry(key, 'table'), 'a foreign key table'), references: freeze(references) })
	})
	if (keys === undefined) {
		throw new PolicyError(`${table}: the column list entry takes foreignKeys, a plain array`)
	}
	return freeze(keys)
}

function parseScope(table: string, scope: Readonly<Record<string, unknown>>, columns: ColumnReader, containment: Containment): ParsedScope {
	const what = `${table}: scope`
	const key = (): string => {
		const stated = ownEntry(scope, 'key')
		return stated === undefined ? columns.derived('id', 'scope.key', 'the key convention', 'scope.key') : columns.column(stated, 'scope.key')
	}
	if (hasOwn(scope, 'dimension')) {
		onlyFields(scope, DIMENSION_FIELDS, what)
		const dimension = nonEmpty(table, ownEntry(scope, 'dimension'), 'scope.dimension')
		const definition = ownEntry(containment, dimension)
		if (definition === undefined) {
			throw new PolicyError(
				`${table}: scope.dimension names ${dimension}, which is not a dimension of the vocabulary (dimensions: ${ownKeys(containment).join(', ')})`,
			)
		}
		const container = parseContainer(table, dimension, definition.container, ownEntry(scope, 'in'), columns)
		return freeze({ mode: 'dimension', dimension, key: key(), container })
	}
	if (hasOwn(scope, 'child')) {
		onlyFields(scope, CHILD_FIELDS, what)
		const column = ownEntry(scope, 'column')
		const inherit = ownEntry(scope, 'inherit')
		return freeze({
			mode: 'child',
			parent: nonEmpty(table, ownEntry(scope, 'child'), 'scope.child'),
			key: key(),
			column: column === undefined ? undefined : columns.column(column, 'scope.column'),
			inherit: inherit === undefined ? undefined : freeze(columns.columnsOf(inherit, 'scope.inherit')),
		})
	}
	if (hasOwn(scope, 'reference')) {
		onlyFields(scope, REFERENCE_FIELDS, what)
		return freeze({ mode: 'reference', reason: nonEmpty(table, ownEntry(scope, 'reference'), 'scope.reference') })
	}
	if (hasOwn(scope, 'inbox')) {
		onlyFields(scope, INBOX_FIELDS, what)
		return freeze({ mode: 'inbox', form: nonEmpty(table, ownEntry(scope, 'inbox'), 'scope.inbox') })
	}
	throw new PolicyError(`${what} takes one mode: { dimension, key?, in? }, { child, key?, column?, inherit? }, { reference } or { inbox, read }`)
}

/**
 * A dimension table's container is the one the vocabulary puts its dimension in, never one the policy chooses. Its
 * column is `<container>_id`, or the one `scope.in.column` names off that convention.
 */
function parseContainer(
	table: string,
	dimension: string,
	container: string | undefined,
	input: unknown,
	columns: ColumnReader,
): Container | undefined {
	if (container === undefined) {
		if (input !== undefined) {
			throw new PolicyError(`${table}: the vocabulary puts ${dimension} in no container, so scope.in is not a field here`)
		}
		return undefined
	}
	if (input === undefined) {
		const column = columns.derived(`${container}_id`, 'scope.in.column', `the vocabulary puts ${dimension} in ${container}`, 'scope.in: { column }')
		return freeze({ dimension: container, column })
	}
	const stated = plainRecord(input, `${table}: scope.in`)
	onlyFields(stated, CONTAINER_FIELDS, `${table}: scope.in`)
	const statedDimension = ownEntry(stated, 'dimension')
	if (statedDimension !== undefined && statedDimension !== container) {
		throw new PolicyError(`${table}: the vocabulary puts ${dimension} in ${container}, not in ${String(statedDimension)}`)
	}
	return freeze({ dimension: container, column: columns.column(ownEntry(stated, 'column'), 'scope.in.column') })
}

function parseActions(
	table: string,
	scope: Readonly<Record<string, unknown>>,
	actionsInput: unknown,
	action: (value: unknown, field: string) => string,
): ActionModel {
	if (hasOwn(scope, 'inbox')) {
		if (actionsInput !== undefined) {
			throw new PolicyError(`${table}: an inbox table takes its read action as scope.read and no actions; only its form appends`)
		}
		return freeze({ read: action(ownEntry(scope, 'read'), 'scope.read'), insert: undefined, update: undefined, delete: undefined })
	}
	if (actionsInput === undefined) {
		throw new PolicyError(`${table}: the policy needs actions`)
	}
	const actions = plainRecord(actionsInput, `${table}: actions`)
	onlyFields(actions, ACTION_FIELDS, `${table}: actions`)
	const optional = (field: 'insert' | 'update' | 'delete') => {
		const value = ownEntry(actions, field)
		return value === undefined ? undefined : action(value, `actions.${field}`)
	}
	return freeze({
		read: action(ownEntry(actions, 'read'), 'actions.read'),
		insert: optional('insert'),
		update: optional('update'),
		delete: optional('delete'),
	})
}

function nonEmpty(table: string, value: unknown, field: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		throw new PolicyError(`${table}: ${field} must be a non-empty string`)
	}
	return value
}

interface Stamp {
	readonly column: string
	readonly role: string
}

/** The columns the layer writes itself: the key, every containment link, the version and the creator. */
function stampsOf(table: ParsedTable, chain: readonly Container[]): readonly Stamp[] {
	const stamps: Stamp[] = []
	if (table.scope.mode === 'dimension' || table.scope.mode === 'child') {
		stamps[stamps.length] = { column: table.scope.key, role: 'the key' }
	}
	for (let index = 0; index < chain.length; index++) {
		const link = chain[index]
		if (link !== undefined) {
			stamps[stamps.length] = { column: link.column, role: `the ${link.dimension} containment column` }
		}
	}
	if (table.version !== undefined) {
		stamps[stamps.length] = { column: table.version, role: 'the version' }
	}
	if (table.createdBy !== undefined) {
		stamps[stamps.length] = { column: table.createdBy, role: 'createdBy' }
	}
	return stamps
}

/**
 * Each stamped column holds one role and is never written by a handler. A shared column would let one stamp
 * overwrite another: `createdBy` on the key inserts the principal as the id, `version` on a container column
 * moves the row on every update.
 */
function checkStamps(table: ParsedTable, chain: readonly Container[]): void {
	const stamps = stampsOf(table, chain)
	for (let index = 0; index < stamps.length; index++) {
		const stamp = stamps[index]
		if (stamp === undefined) {
			continue
		}
		for (let other = 0; other < index; other++) {
			const earlier = stamps[other]
			if (earlier !== undefined && earlier.column === stamp.column) {
				throw new PolicyError(
					`${table.name}: ${stamp.column} is both ${earlier.role} and ${stamp.role}; the layer stamps each, so they need distinct columns`,
				)
			}
		}
		if (inSet(table.insert, stamp.column) || inSet(table.update, stamp.column)) {
			throw new PolicyError(`${table.name}: ${stamp.column} is stamped by the layer; remove it from insert and update`)
		}
	}
}

function prepend(first: Container, rest: readonly Container[]): readonly Container[] {
	const chain: Container[] = [first]
	for (let index = 0; index < rest.length; index++) {
		const link = rest[index]
		if (link !== undefined) {
			chain[chain.length] = link
		}
	}
	return freeze(chain)
}

function includes(names: readonly string[], name: string): boolean {
	for (let index = 0; index < names.length; index++) {
		if (names[index] === name) {
			return true
		}
	}
	return false
}

/** Resolves every table's containment chain and refuses a shape the layer cannot enforce. */
function linkTables(parsed: readonly ParsedTable[], containment: Containment): TableModels {
	const byName: Record<string, ParsedTable> = {}
	const owners: Record<string, ParsedTable> = {}
	for (let index = 0; index < parsed.length; index++) {
		const table = parsed[index]
		if (table === undefined) {
			continue
		}
		setOwn(byName, table.name, table)
		if (table.scope.mode !== 'dimension') {
			continue
		}
		const owner = ownEntry(owners, table.scope.dimension)
		if (owner !== undefined) {
			throw new PolicyError(`${table.name}: dimension ${table.scope.dimension} is already owned by ${owner.name}`)
		}
		setOwn(owners, table.scope.dimension, table)
	}
	for (let index = 0; index < parsed.length; index++) {
		const table = parsed[index]
		if (table !== undefined) {
			checkForeignKeys(table, byName)
		}
	}

	const resolved: Record<string, Resolved> = {}
	const resolve = (table: ParsedTable, visiting: readonly string[]): Resolved => {
		const known = ownEntry(resolved, table.name)
		if (known !== undefined) {
			return known
		}
		const path = [...visiting, table.name]
		if (includes(visiting, table.name)) {
			throw new PolicyError(`${table.name}: its containment is a cycle (${path.join(' → ')})`)
		}
		const result = resolveChain(table, byName, owners, containment, (next) => resolve(next, path).chain)
		const chain = result.chain
		for (let index = 0; index < chain.length; index++) {
			const link = chain[index]
			if (link !== undefined && !inSet(table.columns, link.column)) {
				throw new PolicyError(
					`${table.name}: must carry ${link.column}, because it lies in ${link.dimension}; a row carries its whole containment chain`,
				)
			}
		}
		checkStamps(table, chain)
		setOwn(resolved, table.name, result)
		return result
	}

	const models: Record<string, TableModel> = {}
	for (let index = 0; index < parsed.length; index++) {
		const table = parsed[index]
		if (table !== undefined) {
			const { scope, chain } = resolve(table, [])
			setOwn(models, table.name, freeze({ ...table, scope, chain }))
		}
	}
	return freeze(models)
}

/** A table's scope with nothing left to derive, and its containment chain. */
interface Resolved {
	readonly scope: ScopeModel
	readonly chain: readonly Container[]
}

function resolveChain(
	table: ParsedTable,
	byName: Readonly<Record<string, ParsedTable>>,
	owners: Readonly<Record<string, ParsedTable>>,
	containment: Containment,
	chainOf: (table: ParsedTable) => readonly Container[],
): Resolved {
	/**
	 * The links above `dimension`: the chain of the table that owns it, whose ancestors' columns a contained row carries
	 * under the same names; past a dimension no table owns, the vocabulary's ancestry on the `<dimension>_id` convention.
	 */
	const above = (dimension: string): readonly Container[] => {
		const owner = ownEntry(owners, dimension)
		if (owner !== undefined) {
			return chainOf(owner)
		}
		const container = ownEntry(containment, dimension)?.container
		return container === undefined ? freeze([]) : prepend({ dimension: container, column: `${container}_id` }, above(container))
	}
	const scope = table.scope
	if (scope.mode === 'dimension') {
		const container = scope.container
		if (container === undefined) {
			return { scope, chain: freeze([]) }
		}
		const owner = ownEntry(owners, container.dimension)
		if (owner !== undefined) {
			requireReference(table, container, owner, (column) => `scope.in: { column: '${column}' }`)
		}
		return { scope, chain: prepend(container, above(container.dimension)) }
	}
	if (scope.mode !== 'child') {
		return { scope, chain: freeze([]) }
	}
	const parent = ownEntry(byName, scope.parent)
	if (parent === undefined || parent.scope.mode !== 'dimension') {
		throw new PolicyError(`${table.name}: the parent ${scope.parent} must be a dimension table`)
	}
	const parentChain = chainOf(parent)
	const expected: string[] = []
	for (let index = 0; index < parentChain.length; index++) {
		expected[index] = parentChain[index]?.column ?? ''
	}
	const inherit = scope.inherit ?? freeze(expected)
	const inherited = nameSet(inherit)
	let matches = inherit.length === expected.length && namesOf(inherited).length === expected.length
	for (let index = 0; index < expected.length; index++) {
		matches = matches && inSet(inherited, expected[index])
	}
	if (!matches) {
		throw new PolicyError(
			`${table.name}: must inherit exactly the containment columns of ${scope.parent} (${
				expected.join(', ') || 'none'
			}), so a composite foreign key keeps it in scope`,
		)
	}
	const dimension = parent.scope.dimension
	const link = { dimension, column: scope.column ?? parentColumn(table, `${dimension}_id`, scope.parent) }
	requireReference(table, link, parent, (column) => `scope.column: '${column}'`)
	return {
		scope: freeze({ mode: 'child', parent: scope.parent, key: scope.key, column: link.column, inherit }),
		chain: prepend(link, parentChain),
	}
}

/** Whether a foreign key of `table` takes `column` to `key` of `target`, alone or as part of a composite key. */
function references(table: ParsedTable, column: string, target: string, key: string): boolean {
	for (let index = 0; index < table.foreignKeys.length; index++) {
		const foreignKey = table.foreignKeys[index]
		if (foreignKey === undefined || foreignKey.table !== target) {
			continue
		}
		for (let position = 0; position < foreignKey.columns.length; position++) {
			if (foreignKey.columns[position] === column && foreignKey.references[position] === key) {
				return true
			}
		}
	}
	return false
}

/**
 * A containment column is a foreign key to the key of the table that owns the container: a column that only shares
 * the convention's name would place a row in a scope its real reference contradicts.
 */
function requireReference(table: ParsedTable, link: Container, owner: ParsedTable, fix: (column: string) => string): void {
	const key = owner.scope.mode === 'dimension' ? owner.scope.key : ''
	if (references(table, link.column, owner.name, key)) {
		return
	}
	const names = namesOf(table.columns)
	const candidates: string[] = []
	for (let index = 0; index < names.length; index++) {
		const name = names[index] ?? ''
		if (references(table, name, owner.name, key)) {
			candidates[candidates.length] = name
		}
	}
	const [only] = candidates
	const hint = candidates.length === 1 && only !== undefined
		? `state ${fix(only)}`
		: `add a foreign key from ${link.column} to ${owner.name} (${key}) in a migration`
	throw new PolicyError(`${table.name}: ${link.column} is not a foreign key to ${owner.name}.${key}, which owns ${link.dimension}; ${hint}`)
}

/** Every foreign key names a table of the column list and columns it has. */
function checkForeignKeys(table: ParsedTable, byName: Readonly<Record<string, ParsedTable>>): void {
	for (let index = 0; index < table.foreignKeys.length; index++) {
		const foreignKey = table.foreignKeys[index]
		if (foreignKey === undefined) {
			continue
		}
		const target = ownEntry(byName, foreignKey.table)
		if (target === undefined) {
			throw new PolicyError(`${table.name}: a foreign key references ${foreignKey.table}, which is not a table of the column list`)
		}
		for (let position = 0; position < foreignKey.references.length; position++) {
			const referenced = foreignKey.references[position]
			if (!inSet(target.columns, referenced)) {
				throw new PolicyError(`${table.name}: a foreign key references ${foreignKey.table}.${String(referenced)}, which is not a column`)
			}
		}
	}
}

/** A child's column for its parent defaults to `<parent dimension>_id`. */
function parentColumn(table: ParsedTable, column: string, parent: string): string {
	if (!inSet(table.columns, column)) {
		throw new PolicyError(
			`${table.name}: scope.column defaults to ${column} (the key of its parent ${parent}), which is not a column; state scope.column (columns: ${
				namesOf(table.columns).join(', ')
			})`,
		)
	}
	return column
}

type PolicyOf<P, T> = T extends keyof P ? P[T] : never
type ScopeOf<P, T> = PolicyOf<P, T> extends { readonly scope: infer S } ? S : never

export type Operation = 'read' | 'insert' | 'update' | 'delete'

export type ActionOf<P, T, Op extends Operation> = PolicyOf<P, T> extends { readonly actions: infer Acts }
	? Acts extends { readonly [K in Op]: infer A extends string } ? A
	: never
	: never

export type DimensionOf<P, T> = ScopeOf<P, T> extends { readonly dimension: infer D extends string } ? D : never
export type ContainerOf<P, T> = ScopeOf<P, T> extends { readonly in: { readonly dimension: infer D extends string } } ? D : never
/** The dimension that lists and inserts of T are scoped by: its container, or for a top-level table its own. */
export type ListDimensionOf<P, T> = [ContainerOf<P, T>] extends [never] ? DimensionOf<P, T> : ContainerOf<P, T>
export type ParentOf<P, T> = ScopeOf<P, T> extends { readonly child: infer C extends string } ? C : never

export type DimensionTableName<P> = { [K in keyof P]: P[K] extends { readonly scope: { readonly dimension: string } } ? K : never }[keyof P] & string
export type ChildTableName<P> = { [K in keyof P]: P[K] extends { readonly scope: { readonly child: string } } ? K : never }[keyof P] & string

type ListedColumns<P, T, Field extends 'insert' | 'update'> = PolicyOf<P, T> extends { readonly [K in Field]: readonly (infer C extends string)[] }
	? C
	: never

type Flat<T> = { [K in keyof T]: T[K] }

type ColumnPoliciesOf<P, T> = PolicyOf<P, T> extends { readonly columns: infer C } ? C : never
type TableReadAction<P, T> = PolicyOf<P, T> extends { readonly scope: { readonly read: infer A } } ? A : ActionOf<P, T, 'read'>
/** Columns whose own read action is not the table's: no read returns them. */
type RestrictedColumns<P, T> = [ColumnPoliciesOf<P, T>] extends [never] ? never
	: {
		[K in keyof ColumnPoliciesOf<P, T>]: ColumnPoliciesOf<P, T>[K] extends { readonly read: TableReadAction<P, T> } | undefined ? never : K
	}[keyof ColumnPoliciesOf<P, T>]

export type RowOf<DB, P, T> = T extends keyof DB ? Flat<Omit<Selectable<DB[T]>, RestrictedColumns<P, T>>> : never
export type InsertValues<DB, P, T> = T extends keyof DB ? Flat<Pick<Insertable<DB[T]>, ListedColumns<P, T, 'insert'> & keyof Insertable<DB[T]>>>
	: never
export type UpdateValues<DB, P, T> = T extends keyof DB ? Flat<Pick<Updateable<DB[T]>, ListedColumns<P, T, 'update'> & keyof Updateable<DB[T]>>>
	: never

/** The values a store inserts into table `T` of a `defineTables` result: `TableInsert<typeof tables, 'deals'>`. */
export type TableInsert<Tb, T> = Tb extends Tables<infer DB, infer P> ? InsertValues<DB, P, T> : never
/** The values a store updates in table `T` of a `defineTables` result: `TableUpdate<typeof tables, 'deals'>`. */
export type TableUpdate<Tb, T> = Tb extends Tables<infer DB, infer P> ? UpdateValues<DB, P, T> : never

/** What a mutation answers: the key, and the new version of a versioned table. It returns no row data. */
export type Acknowledgement<P, T> = PolicyOf<P, T> extends { readonly version: string } ? { readonly id: string; readonly version: number }
	: { readonly id: string }

/** A move also answers the object's new containment chain, by dimension. */
export type MoveAcknowledgement<P, T> = Acknowledgement<P, T> & { readonly chain: Readonly<Record<string, string>> }

/** A table with a version column takes `{ expectVersion }` on update; one without takes nothing. */
export type VersionArguments<P, T> = PolicyOf<P, T> extends { readonly version: string } ? [options: { readonly expectVersion: number }] : []

/** Children of T that a select of T can join: their read action is T's read action. */
export type JoinableChildren<DB, P, T> = {
	[K in ChildTableName<P> as ParentOf<P, K> extends T ? (ActionOf<P, K, 'read'> extends ActionOf<P, T, 'read'> ? K : never) : never]: RowOf<DB, P, K>
}
