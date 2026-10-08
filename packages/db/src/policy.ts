import type { Insertable, Selectable, Updateable } from 'kysely'
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

interface WritablePolicy<Col extends string, A extends string> {
	readonly actions: TableActions<A>
	readonly insert?: readonly Col[]
	readonly update?: readonly Col[]
	readonly version?: Col
	readonly createdBy?: Col
	readonly columns?: ColumnPolicies<Col, A>
}

/**
 * A column's own read action. Without one, a column falls back to the table's read action. Every read needs the
 * table's read action, so in v1 a column with a different read action is never returned, filtered or sorted by;
 * it can still be written.
 */
export type ColumnPolicies<Col extends string, A extends string> = { readonly [C in Col]?: { readonly read: A } }

export interface DimensionPolicy<Col extends string, A extends string> extends WritablePolicy<Col, A> {
	readonly scope: DimensionScope<Col>
}

export interface ChildPolicy<Table extends string, Col extends string, A extends string> extends WritablePolicy<Col, A> {
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

export type TablePolicy<Table extends string, Col extends string, A extends string> =
	| DimensionPolicy<Col, A>
	| ChildPolicy<Table, Col, A>
	| ReferencePolicy<Col, A>
	| InboxPolicy<Col, A>

/** Every table of the schema, and no other, maps to a policy. */
export type PolicyMap<DB, A extends string> = {
	readonly [T in keyof DB & string]: TablePolicy<keyof DB & string, keyof DB[T] & string, A>
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
	readonly columns: ReadonlySet<string>
	/** The columns the table's read action reads, in column-list order. */
	readonly visible: readonly string[]
	readonly insert: ReadonlySet<string>
	readonly update: ReadonlySet<string>
	readonly version: string | undefined
	readonly createdBy: string | undefined
	/**
	 * The containment links this table carries a column for, nearest first: a dimension table's container and
	 * the container's own chain; a child's parent and the parent's chain. Every predicate of a Ref covers all.
	 */
	readonly chain: readonly Container[]
}

type ParsedTable = Omit<TableModel, 'chain'>

let readModels: <DB, P>(tables: Tables<DB, P>) => ReadonlyMap<string, TableModel>

/** The validated policies of every table; carries the schema and the literal policy types to the store. */
export class Tables<DB, P> {
	readonly #models: ReadonlyMap<string, TableModel>
	readonly #types: { readonly db?: (db: DB) => DB; readonly policies?: (policies: P) => P } = {}

	constructor(models: ReadonlyMap<string, TableModel>) {
		this.#models = models
	}

	static {
		readModels = (tables) => tables.#models
	}
}
Object.freeze(Tables.prototype)

export function tableModels<DB, P>(tables: Tables<DB, P>): ReadonlyMap<string, TableModel> {
	return readModels(tables)
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
): ReadonlyMap<string, TableModel> {
	const parsed = new Map<string, ParsedTable>()
	for (const table of Object.keys(policies)) {
		if (!Object.hasOwn(columns, table)) {
			throw new PolicyError(`${table}: no such table in the column list (tables: ${Object.keys(columns).join(', ')})`)
		}
	}
	for (const [table, tableColumns] of Object.entries(columns)) {
		const policy = policies[table]
		if (policy === undefined) {
			throw new PolicyError(`${table}: every table needs a policy in tables.ts`)
		}
		parsed.set(table, parseTable(table, tableColumns, policy))
	}
	return linkTables(parsed)
}

function parseTable(table: string, columnNames: readonly string[], policy: AnyPolicy): ParsedTable {
	if (!isPlainIdentifier(table)) {
		throw new PolicyError(`${table}: a table name must match ^[a-z_][a-z0-9_]*$`)
	}
	for (const name of columnNames) {
		if (!isPlainIdentifier(name)) {
			throw new PolicyError(`${table}.${name}: a column name must match ^[a-z_][a-z0-9_]*$`)
		}
	}
	const columns = new Set(columnNames)
	const column = (name: string, field: string): string => {
		if (!columns.has(name)) {
			throw new PolicyError(`${table}: ${field} names ${name}, which is not a column (columns: ${columnNames.join(', ')})`)
		}
		return name
	}
	const scope = parseScope(table, policy, column)
	const actions = parseActions(table, policy)
	const insert = new Set((policy.insert ?? []).map((name) => column(name, 'insert')))
	const update = new Set((policy.update ?? []).map((name) => column(name, 'update')))
	const version = policy.version === undefined ? undefined : column(policy.version, 'version')
	const createdBy = policy.createdBy === undefined ? undefined : column(policy.createdBy, 'createdBy')
	const restricted = new Set<string>()
	const columnPolicies: Readonly<Record<string, { readonly read: string } | undefined>> = policy.columns ?? {}
	for (const [name, columnPolicy] of Object.entries(columnPolicies)) {
		column(name, 'columns')
		if (columnPolicy !== undefined && nonEmpty(table, columnPolicy.read, `columns.${name}.read`) !== actions.read) {
			restricted.add(name)
		}
	}

	const stamped = stampedColumns(scope)
	if (version !== undefined) {
		stamped.add(version)
	}
	if (createdBy !== undefined) {
		stamped.add(createdBy)
	}
	for (const name of [...insert, ...update]) {
		if (stamped.has(name)) {
			throw new PolicyError(`${table}: ${name} is stamped by the layer; remove it from insert and update`)
		}
	}
	if ('key' in scope && restricted.has(scope.key)) {
		throw new PolicyError(`${table}: the key ${scope.key} cannot have its own read action`)
	}
	const writable = scope.mode === 'dimension' || scope.mode === 'child'
	if (!writable && (insert.size > 0 || update.size > 0 || version !== undefined || createdBy !== undefined)) {
		throw new PolicyError(`${table}: a ${scope.mode} table is never written by a handler`)
	}
	return {
		name: table,
		scope,
		actions,
		columns,
		visible: columnNames.filter((name) => !restricted.has(name)),
		insert,
		update,
		version,
		createdBy,
	}
}

function parseScope(table: string, policy: AnyPolicy, column: (name: string, field: string) => string): ScopeModel {
	const scope = policy.scope
	if ('dimension' in scope) {
		const container = scope.in === undefined
			? undefined
			: { dimension: nonEmpty(table, scope.in.dimension, 'scope.in.dimension'), column: column(scope.in.column, 'scope.in.column') }
		return { mode: 'dimension', dimension: nonEmpty(table, scope.dimension, 'scope.dimension'), key: column(scope.key, 'scope.key'), container }
	}
	if ('child' in scope) {
		return {
			mode: 'child',
			parent: scope.child,
			key: column(scope.key, 'scope.key'),
			column: column(scope.column, 'scope.column'),
			inherit: scope.inherit.map((name) => column(name, 'scope.inherit')),
		}
	}
	if ('reference' in scope) {
		return { mode: 'reference', reason: nonEmpty(table, scope.reference, 'scope.reference') }
	}
	return { mode: 'inbox', form: nonEmpty(table, scope.inbox, 'scope.inbox') }
}

function parseActions(table: string, policy: AnyPolicy): ActionModel {
	if ('inbox' in policy.scope) {
		return { read: nonEmpty(table, policy.scope.read, 'scope.read'), insert: undefined, update: undefined, delete: undefined }
	}
	if (policy.actions === undefined) {
		throw new PolicyError(`${table}: the policy needs actions`)
	}
	const actions: TableActions<string> = policy.actions
	const optional = (value: string | undefined, field: string) => value === undefined ? undefined : nonEmpty(table, value, field)
	return {
		read: nonEmpty(table, actions.read, 'actions.read'),
		insert: optional(actions.insert, 'actions.insert'),
		update: optional(actions.update, 'actions.update'),
		delete: optional(actions.delete, 'actions.delete'),
	}
}

function nonEmpty(table: string, value: string, field: string): string {
	if (value.length === 0) {
		throw new PolicyError(`${table}: ${field} cannot be empty`)
	}
	return value
}

function stampedColumns(scope: ScopeModel): Set<string> {
	switch (scope.mode) {
		case 'dimension':
			return new Set(scope.container === undefined ? [scope.key] : [scope.key, scope.container.column])
		case 'child':
			return new Set([scope.key, scope.column, ...scope.inherit])
		default:
			return new Set()
	}
}

/** Resolves every table's containment chain and refuses a shape the layer cannot enforce. */
function linkTables(parsed: ReadonlyMap<string, ParsedTable>): ReadonlyMap<string, TableModel> {
	const owners = new Map<string, ParsedTable>()
	for (const table of parsed.values()) {
		if (table.scope.mode !== 'dimension') {
			continue
		}
		const owner = owners.get(table.scope.dimension)
		if (owner !== undefined) {
			throw new PolicyError(`${table.name}: dimension ${table.scope.dimension} is already owned by ${owner.name}`)
		}
		owners.set(table.scope.dimension, table)
	}

	const chains = new Map<string, readonly Container[]>()
	const chainOf = (table: ParsedTable, visiting: readonly string[]): readonly Container[] => {
		const known = chains.get(table.name)
		if (known !== undefined) {
			return known
		}
		if (visiting.includes(table.name)) {
			throw new PolicyError(`${table.name}: its containment is a cycle (${[...visiting, table.name].join(' → ')})`)
		}
		const chain = resolveChain(table, parsed, owners, (next) => chainOf(next, [...visiting, table.name]))
		for (const link of chain) {
			if (!table.columns.has(link.column)) {
				throw new PolicyError(
					`${table.name}: must carry ${link.column}, because it lies in ${link.dimension}; a row carries its whole containment chain`,
				)
			}
			if (table.insert.has(link.column) || table.update.has(link.column)) {
				throw new PolicyError(`${table.name}: ${link.column} is stamped by the layer; remove it from insert and update`)
			}
		}
		chains.set(table.name, chain)
		return chain
	}

	const models = new Map<string, TableModel>()
	for (const table of parsed.values()) {
		models.set(table.name, { ...table, chain: chainOf(table, []) })
	}
	return models
}

function resolveChain(
	table: ParsedTable,
	parsed: ReadonlyMap<string, ParsedTable>,
	owners: ReadonlyMap<string, ParsedTable>,
	chainOf: (table: ParsedTable) => readonly Container[],
): readonly Container[] {
	const scope = table.scope
	if (scope.mode === 'dimension') {
		if (scope.container === undefined) {
			return []
		}
		const owner = owners.get(scope.container.dimension)
		// An ancestor carries its column under the same name as in the table that owns its dimension.
		return [scope.container, ...(owner === undefined ? [] : chainOf(owner))]
	}
	if (scope.mode !== 'child') {
		return []
	}
	const parent = parsed.get(scope.parent)
	if (parent === undefined || parent.scope.mode !== 'dimension') {
		throw new PolicyError(`${table.name}: the parent ${scope.parent} must be a dimension table`)
	}
	const parentChain = chainOf(parent)
	const expected = parentChain.map((link) => link.column)
	const inherited = new Set(scope.inherit)
	if (inherited.size !== expected.length || !expected.every((name) => inherited.has(name))) {
		throw new PolicyError(
			`${table.name}: must inherit exactly the containment columns of ${scope.parent} (${
				expected.join(', ') || 'none'
			}), so a composite foreign key keeps it in scope`,
		)
	}
	return [{ dimension: parent.scope.dimension, column: scope.column }, ...parentChain]
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
