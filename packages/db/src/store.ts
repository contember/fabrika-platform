import { BinaryOperationNode, type OperationNode, OperatorNode, ValueNode } from 'kysely'
import type { CapabilityAuthority, Ref, RefGrant, Within, WithinGrant } from './capability'
import { type Database, type Session, sessionOf } from './database'
import {
	finishSelect,
	isPrimitive,
	type JoinShape,
	type NoColumns,
	type Primitive,
	type ScopedSelect,
	type SelectState,
	startSelect,
	type TableShape,
} from './description'
import { CapabilityError, ConflictError, NotFoundError, QueryRefusedError } from './errors'
import type { ForeignKeyPair, GuardContext, RootKind } from './guard'
import {
	type AggregateColumns,
	aggregateNode,
	allOf,
	column,
	deleteNode,
	equals,
	everything,
	existsNode,
	inList,
	insertNode,
	scopedWhere,
	selectNode,
	updateNode,
} from './nodes'
import {
	type ActionOf,
	type ChildTableName,
	type Container,
	type ContainerOf,
	type DimensionOf,
	type DimensionTableName,
	type InsertValues,
	type JoinableChildren,
	type ListDimensionOf,
	type Operation,
	type ParentOf,
	type RowOf,
	type TableModel,
	tableModels,
	type Tables,
	type UpdateValues,
	type VersionArguments,
} from './policy'

export interface DataLayerRuntime {
	readonly database: Database
	readonly capabilities: CapabilityAuthority
}

interface TableContext {
	readonly model: TableModel
	readonly parent: TableModel | undefined
	readonly shape: TableShape
	readonly joins: Readonly<Record<string, readonly ForeignKeyPair[]>>
	readonly runtime: DataLayerRuntime
}

interface DimensionScopeModel {
	readonly dimension: string
	readonly key: string
	readonly container: Container | undefined
}

function dimensionScope(model: TableModel): DimensionScopeModel {
	if (model.scope.mode !== 'dimension') {
		throw new CapabilityError(`${model.name} is not a dimension table`)
	}
	return model.scope
}

function childScope(context: TableContext): { readonly key: string; readonly column: string; readonly parent: DimensionScopeModel } {
	const scope = context.model.scope
	if (scope.mode !== 'child' || context.parent === undefined) {
		throw new CapabilityError(`${context.model.name} is not a child table`)
	}
	return { key: scope.key, column: scope.column, parent: dimensionScope(context.parent) }
}

/** The dimension that lists and inserts are scoped by: the container, or for a top-level table its own. */
function listDimension(scope: DimensionScopeModel): string {
	return scope.container?.dimension ?? scope.dimension
}

function requiredAction(context: TableContext, operation: Operation): string {
	const action = context.model.actions[operation]
	if (action === undefined) {
		throw new CapabilityError(`${context.model.name} allows no ${operation}; its policy declares no ${operation} action`)
	}
	return action
}

function checkGrant(context: TableContext, grant: RefGrant | WithinGrant, dimension: string, operation: Operation): void {
	const action = requiredAction(context, operation)
	if (grant.dimension !== dimension) {
		throw new CapabilityError(`${operation} on ${context.model.name} needs a ${grant.kind} of ${dimension}, got a ${grant.kind} of ${grant.dimension}`)
	}
	if (grant.action !== action) {
		throw new CapabilityError(`${operation} on ${context.model.name} requires ${action}; the capability holds ${grant.action}`)
	}
}

function refGrant(context: TableContext, capability: unknown, dimension: string, operation: Operation): RefGrant {
	const grant = context.runtime.capabilities.resolve(capability)
	if (grant.kind !== 'ref') {
		throw new CapabilityError(`${operation} on ${context.model.name} needs a Ref of ${dimension}, got a Within`)
	}
	checkGrant(context, grant, dimension, operation)
	return grant
}

function withinGrant(context: TableContext, capability: unknown, dimension: string, operation: Operation): WithinGrant {
	const grant = context.runtime.capabilities.resolve(capability)
	if (grant.kind !== 'within') {
		throw new CapabilityError(`${operation} on ${context.model.name} needs a Within of ${dimension}, got a Ref`)
	}
	checkGrant(context, grant, dimension, operation)
	return grant
}

function chainValue(grant: RefGrant, dimension: string): string {
	const value = grant.chain.get(dimension)
	if (value === undefined) {
		throw new CapabilityError(`the Ref of ${grant.dimension} carries no ${dimension} in its chain`)
	}
	return value
}

/** Undefined for an empty `Within`: the caller answers `[]` without a query. */
function withinPredicate(table: string, column: string, grant: WithinGrant): OperationNode | undefined {
	if (grant.values === 'all') {
		return everything()
	}
	return grant.values.length === 0 ? undefined : inList(table, column, grant.values)
}

/** This object, over the whole chain the Ref carries. */
function objectPredicate(context: TableContext, capability: unknown, operation: Operation): OperationNode {
	const scope = dimensionScope(context.model)
	const grant = refGrant(context, capability, scope.dimension, operation)
	const key = equals(context.model.name, scope.key, grant.id)
	if (scope.container === undefined) {
		return key
	}
	return allOf([key, equals(context.model.name, scope.container.column, chainValue(grant, scope.container.dimension))])
}

/** Rows of a dimension table within the scope values of its list dimension. */
function dimensionListPredicate(context: TableContext, capability: unknown, operation: Operation): OperationNode | undefined {
	const scope = dimensionScope(context.model)
	const grant = withinGrant(context, capability, listDimension(scope), operation)
	return withinPredicate(context.model.name, scope.container?.column ?? scope.key, grant)
}

/** Rows of a child table that belong to the parent object the Ref names, over the whole chain. */
function parentPredicate(context: TableContext, grant: RefGrant): OperationNode {
	const scope = childScope(context)
	const parentKey = equals(context.model.name, scope.column, grant.id)
	const container = scope.parent.container
	if (container === undefined) {
		return parentKey
	}
	return allOf([parentKey, equals(context.model.name, container.column, chainValue(grant, container.dimension))])
}

function childListPredicate(context: TableContext, capability: unknown, operation: Operation): OperationNode | undefined {
	const scope = childScope(context)
	const grant = context.runtime.capabilities.resolve(capability)
	if (grant.kind === 'ref') {
		checkGrant(context, grant, scope.parent.dimension, operation)
		return parentPredicate(context, grant)
	}
	checkGrant(context, grant, listDimension(scope.parent), operation)
	return withinPredicate(context.model.name, scope.parent.container?.column ?? scope.column, grant)
}

function childObjectPredicate(context: TableContext, parent: unknown, key: unknown, operation: Operation): OperationNode {
	const scope = childScope(context)
	if (typeof key !== 'string' || key.length === 0) {
		throw new QueryRefusedError(`a ${context.model.name} row is addressed by its parent Ref and its ${scope.key}`)
	}
	const grant = refGrant(context, parent, scope.parent.dimension, operation)
	return allOf([equals(context.model.name, scope.key, key), parentPredicate(context, grant)])
}

function guard(context: TableContext, root: RootKind, scope: OperationNode | undefined): GuardContext {
	return { root, table: context.model.name, joins: root === 'SelectQueryNode' ? context.joins : {}, scope }
}

function session(context: TableContext): Session {
	return sessionOf(context.runtime.database)
}

/** Refuses unknown keys (an agent learns about them) and anything but plain values. */
function copyAllowed(values: unknown, allowed: ReadonlySet<string>, what: 'insert' | 'update', table: string): Map<string, Primitive | null> {
	if (typeof values !== 'object' || values === null || Array.isArray(values)) {
		throw new QueryRefusedError(`${what} takes an object of column values`)
	}
	const copied = new Map<string, Primitive | null>()
	const entries: [string, unknown][] = Object.entries(values)
	for (const [key, value] of entries) {
		if (!allowed.has(key)) {
			const columns = [...allowed].join(', ') || 'none'
			throw new QueryRefusedError(`${key} is not an ${what} column of ${table} (${what} columns: ${columns})`)
		}
		if (value === undefined) {
			continue
		}
		if (value !== null && !isPrimitive(value)) {
			throw new QueryRefusedError(`${table}.${key} takes a plain value (string, number, bigint, boolean, Date or null)`)
		}
		copied.set(key, value)
	}
	return copied
}

function stampInsert(context: TableContext, grant: RefGrant, values: Map<string, Primitive | null>, key: string, keyValue: string): void {
	values.set(key, keyValue)
	if (context.model.version !== undefined) {
		values.set(context.model.version, 1)
	}
	if (context.model.createdBy !== undefined) {
		values.set(context.model.createdBy, grant.principal)
	}
}

function versionArgument(context: TableContext, options: readonly unknown[]): OperationNode | undefined {
	const version = context.model.version
	if (version === undefined) {
		return undefined
	}
	const [first] = options
	const expected: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'expectVersion') : undefined
	if (typeof expected !== 'number' || !Number.isSafeInteger(expected)) {
		throw new QueryRefusedError(`${context.model.name} has a version column; update takes { expectVersion: number }`)
	}
	return BinaryOperationNode.create(column(context.model.name, version), OperatorNode.create('='), ValueNode.create(expected))
}

async function selectRows<S>(context: TableContext, scope: OperationNode | undefined, state: SelectState, action: string): Promise<S[]> {
	for (const join of state.joins) {
		if (join.join.readAction !== action) {
			throw new CapabilityError(`joining ${join.join.shape.table} requires ${join.join.readAction}; the capability holds ${action}`)
		}
	}
	if (scope === undefined) {
		return []
	}
	return session(context).run<S>(selectNode(state, context.model.visible, scope), guard(context, 'SelectQueryNode', scope))
}

async function selectOne<O>(context: TableContext, scope: OperationNode): Promise<O> {
	const start = startSelect(context.shape)
	const state = finishSelect(start, start)
	const [row] = await session(context).run<O>(selectNode(state, context.model.visible, scope), guard(context, 'SelectQueryNode', scope))
	if (row === undefined) {
		throw new NotFoundError(`${context.model.name} not found`)
	}
	return row
}

async function insertRow<O>(context: TableContext, values: ReadonlyMap<string, Primitive | null>): Promise<O> {
	const [row] = await session(context).run<O>(
		insertNode(context.model.name, values, context.model.visible),
		guard(context, 'InsertQueryNode', undefined),
	)
	if (row === undefined) {
		throw new QueryRefusedError(`the insert into ${context.model.name} returned no row`)
	}
	return row
}

/** Zero changed rows → one follow-up read in the same transaction → 404 when the object is gone, else 409. */
async function updateRow<O>(
	context: TableContext,
	scope: OperationNode,
	changes: ReadonlyMap<string, Primitive | null>,
	expectedVersion: OperationNode | undefined,
): Promise<O> {
	const table = context.model.name
	const node = updateNode(table, changes, context.model.version, scopedWhere(expectedVersion, scope), context.model.visible)
	return session(context).transaction(async (transaction) => {
		const [row] = await transaction.run<O>(node, guard(context, 'UpdateQueryNode', scope))
		if (row !== undefined) {
			return row
		}
		if (expectedVersion !== undefined) {
			const key = context.model.scope.mode === 'dimension' || context.model.scope.mode === 'child' ? context.model.scope.key : ''
			const existing = await transaction.run(existsNode(table, key, scope), guard(context, 'SelectQueryNode', scope))
			if (existing.length > 0) {
				throw new ConflictError(`${table} was changed by someone else; read it again and retry`)
			}
		}
		throw new NotFoundError(`${table} not found`)
	})
}

async function removeRow(context: TableContext, scope: OperationNode, key: string): Promise<void> {
	const rows = await session(context).run(deleteNode(context.model.name, scopedWhere(undefined, scope), key), guard(context, 'DeleteQueryNode', scope))
	if (rows.length === 0) {
		throw new NotFoundError(`${context.model.name} not found`)
	}
}

type Columns<Row> = keyof Row & string
type NumericColumn<Row> = { [K in Columns<Row>]: Exclude<Row[K], null> extends number | bigint | string ? K : never }[Columns<Row>]

export interface AggregateSpec<Row> {
	readonly groupBy?: readonly Columns<Row>[]
	readonly count?: boolean
	readonly sum?: readonly NumericColumn<Row>[]
	readonly min?: readonly Columns<Row>[]
	readonly max?: readonly Columns<Row>[]
	readonly where?: (q: ScopedSelect<Row, Row, NoColumns>) => ScopedSelect<Row, unknown, NoColumns>
}

type Listed<S, K extends 'groupBy' | 'sum' | 'min' | 'max'> = S extends { readonly [P in K]: readonly (infer C extends string)[] } ? C : never
type Flat<T> = { [K in keyof T]: T[K] }

/**
 * `count` is a string because Postgres returns a bigint. A sum is a string for integer and numeric columns and a
 * number for floating-point ones; the column type alone cannot tell them apart.
 */
export type AggregateRow<Row, S> = Flat<
	& Pick<Row, Listed<S, 'groupBy'> & keyof Row>
	& (S extends { readonly count: true } ? { readonly count: string } : NoColumns)
	& { readonly [K in Listed<S, 'sum'> as `sum_${K}`]: string | number | null }
	& { readonly [K in Listed<S, 'min'> & keyof Row as `min_${K}`]: Row[K] | null }
	& { readonly [K in Listed<S, 'max'> & keyof Row as `max_${K}`]: Row[K] | null }
>

/** The aggregate spec as it arrives at runtime, where the types may have been defeated. */
interface AggregateInput {
	readonly groupBy?: unknown
	readonly count?: unknown
	readonly sum?: unknown
	readonly min?: unknown
	readonly max?: unknown
}

function aggregateColumns(context: TableContext, spec: AggregateInput): AggregateColumns {
	const list = (field: string, value: unknown): string[] => {
		if (value === undefined) {
			return []
		}
		if (!Array.isArray(value)) {
			throw new QueryRefusedError(`aggregate ${field} takes a list of column names`)
		}
		return value.map((name: unknown) => {
			if (typeof name !== 'string' || !context.shape.visible.has(name)) {
				throw new QueryRefusedError(`${String(name)} is not a column of ${context.model.name} (columns: ${context.model.visible.join(', ')})`)
			}
			return name
		})
	}
	const count = spec.count === true
	const columns = { groupBy: list('groupBy', spec.groupBy), count, sum: list('sum', spec.sum), min: list('min', spec.min), max: list('max', spec.max) }
	if (!count && columns.sum.length === 0 && columns.min.length === 0 && columns.max.length === 0) {
		throw new QueryRefusedError('aggregate needs count, sum, min or max')
	}
	return columns
}

function aggregateFilter<Row>(context: TableContext, where: AggregateSpec<Row>['where']): SelectState | undefined {
	if (where === undefined) {
		return undefined
	}
	if (typeof where !== 'function') {
		throw new QueryRefusedError('aggregate where takes a callback')
	}
	const start = startSelect<Row, NoColumns>(context.shape)
	const state = finishSelect(where(start), start)
	if (state.columns !== undefined || state.orderBy.length > 0 || state.limit !== undefined || state.offset !== undefined || state.joins.length > 0) {
		throw new QueryRefusedError('aggregate where takes where conditions only')
	}
	return state
}

async function aggregateRows<Row, O>(context: TableContext, scope: OperationNode | undefined, spec: AggregateSpec<Row>): Promise<O[]> {
	if (typeof spec !== 'object' || spec === null) {
		throw new QueryRefusedError('aggregate takes { groupBy, count, sum, min, max, where }')
	}
	const columns = aggregateColumns(context, spec)
	const filter = aggregateFilter(context, spec.where)
	if (scope === undefined) {
		return []
	}
	const node = aggregateNode(context.model.name, columns, filter?.conditions ?? [], scope)
	return session(context).run<O>(node, guard(context, 'SelectQueryNode', scope))
}

type ReadAction<P, T> = ActionOf<P, T, 'read'>
type Row<DB, P, T> = RowOf<DB, P, T>
type Joinable<DB, P, T> = JoinableChildren<DB, P, T>
type ParentDimension<P, T> = DimensionOf<P, ParentOf<P, T>>

/** The table handle of a dimension table: every entry point takes a `Ref` or a `Within`. */
export class DimensionTable<DB, P, T extends string> {
	readonly #context: TableContext
	readonly #types: { readonly db?: DB; readonly policies?: P; readonly table?: T } = {}

	constructor(context: TableContext) {
		this.#context = context
		Object.freeze(this)
	}

	async select<S>(
		within: Within<ListDimensionOf<P, T>, ReadAction<P, T>>,
		build: (q: ScopedSelect<Row<DB, P, T>, Row<DB, P, T>, Joinable<DB, P, T>>) => ScopedSelect<Row<DB, P, T>, S, Joinable<DB, P, T>>,
	): Promise<S[]> {
		const context = this.#context
		const scope = dimensionListPredicate(context, within, 'read')
		const start = startSelect<Row<DB, P, T>, Joinable<DB, P, T>>(context.shape)
		const state = finishSelect(build(start), start)
		return selectRows<S>(context, scope, state, requiredAction(context, 'read'))
	}

	async get(ref: Ref<DimensionOf<P, T>, ReadAction<P, T>>): Promise<Row<DB, P, T>> {
		return selectOne(this.#context, objectPredicate(this.#context, ref, 'read'))
	}

	/** Into a container (the key is a new UUIDv7), or for a top-level table the object the `Ref` names. */
	async insert(target: Ref<ListDimensionOf<P, T>, ActionOf<P, T, 'insert'>>, values: InsertValues<DB, P, T>): Promise<Row<DB, P, T>> {
		const context = this.#context
		const scope = dimensionScope(context.model)
		const grant = refGrant(context, target, listDimension(scope), 'insert')
		const row = copyAllowed(values, context.model.insert, 'insert', context.model.name)
		if (scope.container === undefined) {
			stampInsert(context, grant, row, scope.key, grant.id)
		} else {
			stampInsert(context, grant, row, scope.key, Bun.randomUUIDv7())
			row.set(scope.container.column, grant.id)
		}
		return insertRow(context, row)
	}

	async update(
		ref: Ref<DimensionOf<P, T>, ActionOf<P, T, 'update'>>,
		values: UpdateValues<DB, P, T>,
		...options: VersionArguments<P, T>
	): Promise<Row<DB, P, T>> {
		const context = this.#context
		const scope = objectPredicate(context, ref, 'update')
		const changes = copyAllowed(values, context.model.update, 'update', context.model.name)
		return updateRow(context, scope, changes, versionArgument(context, options))
	}

	async remove(ref: Ref<DimensionOf<P, T>, ActionOf<P, T, 'delete'>>): Promise<void> {
		const context = this.#context
		await removeRow(context, objectPredicate(context, ref, 'delete'), dimensionScope(context.model).key)
	}

	/**
	 * Moves the object to another container: the delete action at the source, the insert action at the target.
	 * Children that copy the container column follow through `ON UPDATE CASCADE` on their composite foreign key.
	 */
	async move(ref: Ref<DimensionOf<P, T>, ActionOf<P, T, 'delete'>>, to: Ref<ContainerOf<P, T>, ActionOf<P, T, 'insert'>>): Promise<Row<DB, P, T>> {
		const context = this.#context
		const container = dimensionScope(context.model).container
		if (container === undefined) {
			throw new CapabilityError(`${context.model.name} has no container to move between`)
		}
		const scope = objectPredicate(context, ref, 'delete')
		const target = refGrant(context, to, container.dimension, 'insert')
		return updateRow(context, scope, new Map([[container.column, target.id]]), undefined)
	}

	async aggregate<const S extends AggregateSpec<Row<DB, P, T>>>(
		within: Within<ListDimensionOf<P, T>, ReadAction<P, T>>,
		spec: S,
	): Promise<AggregateRow<Row<DB, P, T>, S>[]> {
		return aggregateRows(this.#context, dimensionListPredicate(this.#context, within, 'read'), spec)
	}
}
Object.freeze(DimensionTable.prototype)

/** The scope a child list is reached through: one parent object, or the parent's list dimension. */
export type ChildListScope<P, T> =
	| Ref<ParentDimension<P, T>, ReadAction<P, T>>
	| Within<ListDimensionOf<P, ParentOf<P, T>>, ReadAction<P, T>>

/** The table handle of a child table: one row is addressed by its parent's `Ref` and its own key. */
export class ChildTable<DB, P, T extends string> {
	readonly #context: TableContext
	readonly #types: { readonly db?: DB; readonly policies?: P; readonly table?: T } = {}

	constructor(context: TableContext) {
		this.#context = context
		Object.freeze(this)
	}

	async select<S>(
		scope: ChildListScope<P, T>,
		build: (q: ScopedSelect<Row<DB, P, T>, Row<DB, P, T>, NoColumns>) => ScopedSelect<Row<DB, P, T>, S, NoColumns>,
	): Promise<S[]> {
		const context = this.#context
		const predicate = childListPredicate(context, scope, 'read')
		const start = startSelect<Row<DB, P, T>, NoColumns>(context.shape)
		const state = finishSelect(build(start), start)
		return selectRows<S>(context, predicate, state, requiredAction(context, 'read'))
	}

	async get(parent: Ref<ParentDimension<P, T>, ReadAction<P, T>>, key: string): Promise<Row<DB, P, T>> {
		return selectOne(this.#context, childObjectPredicate(this.#context, parent, key, 'read'))
	}

	async insert(parent: Ref<ParentDimension<P, T>, ActionOf<P, T, 'insert'>>, values: InsertValues<DB, P, T>): Promise<Row<DB, P, T>> {
		const context = this.#context
		const scope = childScope(context)
		const grant = refGrant(context, parent, scope.parent.dimension, 'insert')
		const row = copyAllowed(values, context.model.insert, 'insert', context.model.name)
		stampInsert(context, grant, row, scope.key, Bun.randomUUIDv7())
		row.set(scope.column, grant.id)
		const container = scope.parent.container
		if (container !== undefined) {
			row.set(container.column, chainValue(grant, container.dimension))
		}
		return insertRow(context, row)
	}

	async update(
		parent: Ref<ParentDimension<P, T>, ActionOf<P, T, 'update'>>,
		key: string,
		values: UpdateValues<DB, P, T>,
		...options: VersionArguments<P, T>
	): Promise<Row<DB, P, T>> {
		const context = this.#context
		const scope = childObjectPredicate(context, parent, key, 'update')
		const changes = copyAllowed(values, context.model.update, 'update', context.model.name)
		return updateRow(context, scope, changes, versionArgument(context, options))
	}

	async remove(parent: Ref<ParentDimension<P, T>, ActionOf<P, T, 'delete'>>, key: string): Promise<void> {
		const context = this.#context
		await removeRow(context, childObjectPredicate(context, parent, key, 'delete'), childScope(context).key)
	}

	async aggregate<const S extends AggregateSpec<Row<DB, P, T>>>(scope: ChildListScope<P, T>, spec: S): Promise<AggregateRow<Row<DB, P, T>, S>[]> {
		return aggregateRows(this.#context, childListPredicate(this.#context, scope, 'read'), spec)
	}
}
Object.freeze(ChildTable.prototype)

function shapeOf(model: TableModel, joinable: ReadonlyMap<string, JoinShape>): TableShape {
	return { table: model.name, visible: new Set(model.visible), joinable }
}

function joinShapes(models: ReadonlyMap<string, TableModel>, parent: TableModel): Map<string, JoinShape> {
	const joinable = new Map<string, JoinShape>()
	if (parent.scope.mode !== 'dimension') {
		return joinable
	}
	for (const model of models.values()) {
		if (model.scope.mode === 'child' && model.scope.parent === parent.name) {
			const on = [
				{ childColumn: model.scope.column, parentColumn: parent.scope.key },
				...model.scope.inherit.map((name) => ({ childColumn: name, parentColumn: name })),
			]
			joinable.set(model.name, { shape: shapeOf(model, new Map()), readAction: model.actions.read, on })
		}
	}
	return joinable
}

/**
 * Binds the table policies to a database and a capability authority. The framework calls it once; application
 * modules import the `defineStore` and `defineChildStore` it returns.
 */
export function scoped<DB, P>(tables: Tables<DB, P>, runtime: DataLayerRuntime) {
	const models = tableModels(tables)

	function contextFor(table: string, mode: 'dimension' | 'child'): TableContext {
		const model = models.get(table)
		if (model === undefined || model.scope.mode !== mode) {
			throw new QueryRefusedError(`${table} is not a ${mode} table`)
		}
		const parent = model.scope.mode === 'child' ? models.get(model.scope.parent) : undefined
		const joinable = joinShapes(models, model)
		const joins = Object.freeze(Object.fromEntries([...joinable].map(([name, join]) => [name, join.on])))
		return Object.freeze({ model, parent, shape: shapeOf(model, joinable), joins, runtime })
	}

	return Object.freeze({
		defineStore<const T extends DimensionTableName<P>, S>(table: T, build: (t: DimensionTable<DB, P, T>) => S): S {
			return build(new DimensionTable(contextFor(table, 'dimension')))
		},
		defineChildStore<const T extends ChildTableName<P>, S>(table: T, build: (t: ChildTable<DB, P, T>) => S): S {
			return build(new ChildTable(contextFor(table, 'child')))
		},
	})
}
