import type { Insertable, Selectable, SelectType, Updateable } from 'kysely'
import { freeze, hasOwn, inSet, type NameSet, nameSet, namesOf, ownEntry, ownKeys, parseList, setOwn } from './builtins'
import { PolicyError } from './errors'
import { isPlainIdentifier } from './identifier'

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

export type TablePolicy<Table extends string, Col extends string, A extends string, V extends Col = Col> =
	| DimensionPolicy<Col, A, V>
	| ChildPolicy<Table, Col, A, V>
	| ReferencePolicy<Col, A>
	| InboxPolicy<Col, A>

/** The columns a version can live in: those whose generated select type is `number`, an INTEGER (int4). */
export type VersionColumn<Row> = { [K in keyof Row & string]: SelectType<Row[K]> extends number ? K : never }[keyof Row & string]

/** Every table of the schema, and no other, maps to a policy. */
export type PolicyMap<DB, A extends string> = {
	readonly [T in keyof DB & string]: TablePolicy<keyof DB & string, keyof DB[T] & string, A, VersionColumn<DB[T]>>
}

/** The column names of every table, generated next to the schema types. */
export type ColumnList<DB> = { readonly [T in keyof DB & string]: readonly (keyof DB[T] & string)[] }

type AnyPolicy = TablePolicy<string, string, string>

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
	/**
	 * The containment links this table carries a column for, nearest first: a dimension table's container and
	 * the container's own chain; a child's parent and the parent's chain. Every predicate of a Ref covers all.
	 */
	readonly chain: readonly Container[]
}

type ParsedTable = Omit<TableModel, 'chain'>

let readModels: <DB, P>(tables: Tables<DB, P>) => TableModels

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
	}
}
Object.freeze(Tables.prototype)

export function tableModels<DB, P>(tables: Tables<DB, P>): TableModels {
	return readModels(tables)
}

export function modelOf(models: TableModels, table: string): TableModel | undefined {
	return ownEntry(models, table)
}

/**
 * Declares the access policy of every table. `columns` is the generated column list; the policies are a literal.
 * `defineTables<DB, Action>(columns)({ notes: { scope: …, actions: … }, … })`.
 */
export function defineTables<DB, A extends string>(columns: ColumnList<DB>) {
	return <const P extends PolicyMap<DB, A>>(policies: P & { readonly [K in Exclude<keyof P, keyof DB>]: never }): Tables<DB, P> =>
		new Tables(parseTables(columns, policies))
}

function parseTables(
	columns: Readonly<Record<string, readonly string[]>>,
	policies: Readonly<Record<string, AnyPolicy>>,
): TableModels {
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
		parsed[index] = parseTable(table, ownEntry(columns, table), policy)
	}
	return linkTables(parsed)
}

function parseTable(table: string, columnList: unknown, policy: AnyPolicy): ParsedTable {
	if (!isPlainIdentifier(table)) {
		throw new PolicyError(`${table}: a table name must match ^[a-z_][a-z0-9_]*$`)
	}
	const columnNames = parseList(columnList, (name) => {
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
	const scope = parseScope(table, policy, column, columnsOf)
	const actions = parseActions(table, policy)
	const insert = nameSet(columnsOf(policy.insert, 'insert'))
	const update = nameSet(columnsOf(policy.update, 'update'))
	const version = policy.version === undefined ? undefined : column(policy.version, 'version')
	const createdBy = policy.createdBy === undefined ? undefined : column(policy.createdBy, 'createdBy')
	const restricted: string[] = []
	const columnPolicies: Readonly<Record<string, { readonly read: string } | undefined>> = policy.columns ?? {}
	const restrictable = ownKeys(columnPolicies)
	for (let index = 0; index < restrictable.length; index++) {
		const name = column(restrictable[index], 'columns')
		const columnPolicy = ownEntry(columnPolicies, name)
		if (columnPolicy !== undefined && nonEmpty(table, columnPolicy.read, `columns.${name}.read`) !== actions.read) {
			restricted[restricted.length] = name
		}
	}
	const hidden = nameSet(restricted)

	if ((scope.mode === 'dimension' || scope.mode === 'child') && inSet(hidden, scope.key)) {
		throw new PolicyError(`${table}: the key ${scope.key} cannot have its own read action`)
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
	return { name: table, scope, actions, columns, visible: freeze(visible), insert, update, version, createdBy }
}

function parseScope(
	table: string,
	policy: AnyPolicy,
	column: (name: unknown, field: string) => string,
	columnsOf: (value: unknown, field: string) => string[],
): ScopeModel {
	const scope = policy.scope
	if ('dimension' in scope) {
		const container = scope.in === undefined
			? undefined
			: freeze({ dimension: nonEmpty(table, scope.in.dimension, 'scope.in.dimension'), column: column(scope.in.column, 'scope.in.column') })
		return freeze({
			mode: 'dimension',
			dimension: nonEmpty(table, scope.dimension, 'scope.dimension'),
			key: column(scope.key, 'scope.key'),
			container,
		})
	}
	if ('child' in scope) {
		return freeze({
			mode: 'child',
			parent: scope.child,
			key: column(scope.key, 'scope.key'),
			column: column(scope.column, 'scope.column'),
			inherit: freeze(columnsOf(scope.inherit, 'scope.inherit')),
		})
	}
	if ('reference' in scope) {
		return freeze({ mode: 'reference', reason: nonEmpty(table, scope.reference, 'scope.reference') })
	}
	return freeze({ mode: 'inbox', form: nonEmpty(table, scope.inbox, 'scope.inbox') })
}

function parseActions(table: string, policy: AnyPolicy): ActionModel {
	if ('inbox' in policy.scope) {
		return freeze({ read: nonEmpty(table, policy.scope.read, 'scope.read'), insert: undefined, update: undefined, delete: undefined })
	}
	if (policy.actions === undefined) {
		throw new PolicyError(`${table}: the policy needs actions`)
	}
	const actions: TableActions<string> = policy.actions
	const optional = (value: string | undefined, field: string) => value === undefined ? undefined : nonEmpty(table, value, field)
	return freeze({
		read: nonEmpty(table, actions.read, 'actions.read'),
		insert: optional(actions.insert, 'actions.insert'),
		update: optional(actions.update, 'actions.update'),
		delete: optional(actions.delete, 'actions.delete'),
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
function linkTables(parsed: readonly ParsedTable[]): TableModels {
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

	const chains: Record<string, readonly Container[]> = {}
	const chainOf = (table: ParsedTable, visiting: readonly string[]): readonly Container[] => {
		const known = ownEntry(chains, table.name)
		if (known !== undefined) {
			return known
		}
		const path = [...visiting, table.name]
		if (includes(visiting, table.name)) {
			throw new PolicyError(`${table.name}: its containment is a cycle (${path.join(' → ')})`)
		}
		const chain = resolveChain(table, byName, owners, (next) => chainOf(next, path))
		for (let index = 0; index < chain.length; index++) {
			const link = chain[index]
			if (link !== undefined && !inSet(table.columns, link.column)) {
				throw new PolicyError(
					`${table.name}: must carry ${link.column}, because it lies in ${link.dimension}; a row carries its whole containment chain`,
				)
			}
		}
		checkStamps(table, chain)
		setOwn(chains, table.name, chain)
		return chain
	}

	const models: Record<string, TableModel> = {}
	for (let index = 0; index < parsed.length; index++) {
		const table = parsed[index]
		if (table !== undefined) {
			setOwn(models, table.name, freeze({ ...table, chain: chainOf(table, []) }))
		}
	}
	return freeze(models)
}

function resolveChain(
	table: ParsedTable,
	byName: Readonly<Record<string, ParsedTable>>,
	owners: Readonly<Record<string, ParsedTable>>,
	chainOf: (table: ParsedTable) => readonly Container[],
): readonly Container[] {
	const scope = table.scope
	if (scope.mode === 'dimension') {
		if (scope.container === undefined) {
			return freeze([])
		}
		const owner = ownEntry(owners, scope.container.dimension)
		// An ancestor carries its column under the same name as in the table that owns its dimension.
		return prepend(scope.container, owner === undefined ? [] : chainOf(owner))
	}
	if (scope.mode !== 'child') {
		return freeze([])
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
	const inherited = nameSet(scope.inherit)
	let matches = scope.inherit.length === expected.length && namesOf(inherited).length === expected.length
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
	return prepend({ dimension: parent.scope.dimension, column: scope.column }, parentChain)
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
