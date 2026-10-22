import { uuidv7 } from '@fabrika/platform'
import { BinaryOperationNode, type OperationNode, OperatorNode, type ReturningNode, ValueNode } from 'kysely'
import { admissions } from './admissions'
import {
	defineValue,
	freeze,
	hasOwn,
	inSet,
	isArray,
	isSafeInteger,
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
import {
	type AppGrant,
	type CapabilityAuthority,
	type CapabilityGrant,
	describeGrant,
	MAX_WITHIN_VALUES,
	type Ref,
	type RefGrant,
	type Within,
	type WithinGrant,
} from './capability'
import { type Database, InvocationTransaction, type Session, sessionOf, type SqlDialect } from './database'
import {
	type Compare,
	type Condition,
	type Contains,
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
import { CapabilityError, ConflictError, NotFoundError, PolicyError, QueryRefusedError } from './errors'
import { answerFiles, type FileBinding, fileValue, referenceFiles, rowScope, storedRowScope } from './file-columns'
import { fileReference } from './file-references'
import { webhookTables } from './framework-tables'
import type { ForeignKeyPair, GuardContext, RootKind } from './guard'
import { fencedTransaction, jobLeases } from './job-leases'
import { linksPredicate, linkValues } from './links'
import {
	acknowledgement,
	acknowledgementNode,
	type AggregateColumns,
	aggregateNode,
	allOf,
	anyOf,
	column,
	deleteNode,
	equals,
	everything,
	existsNode,
	inList,
	insertNode,
	locateNode,
	lockNode,
	scopedWhere,
	selectNode,
	updateNode,
} from './nodes'
import { dataAccess } from './orm'
import {
	type Acknowledgement,
	type ActionOf,
	type ChildTableName,
	type Container,
	type ContainerOf,
	type DimensionOf,
	type DimensionTableName,
	includes,
	type InsertValues,
	type JoinableChildren,
	type ListDimensionOf,
	modelOf,
	type MoveAcknowledgement,
	namesAction,
	type Operation,
	type ParentOf,
	type PolicyRow,
	type TableModel,
	type TableModels,
	tableModels,
	type Tables,
	updatableBy,
	updateActions,
	type UpdateValues,
	type VersionArguments,
	visibleFor,
} from './policy'
import { frameworkSideOf, type Locator, register } from './registry'
import type { ScopeTerms, ScopeTest, ScopeUse } from './sql'
import { storedFiles, storedFilesMetadata } from './stored-files'
import { type TablePolicies, tablePolicies } from './tables'
import { answerRows, dayInput, type RowColumns, storedTimestamp, timestampInput } from './temporal'

export interface DataLayerRuntime {
	readonly database: Database
	readonly capabilities: CapabilityAuthority
	/** Whether the request running now may only read (an export's); its every statement then runs `READ ONLY`. */
	readonly readOnly?: () => boolean
}

/** Empty until the framework connects the layer at boot; every table handle of one `scoped` call shares it. */
export interface Connection {
	runtime: DataLayerRuntime | undefined
}

export interface TableContext {
	readonly model: TableModel
	readonly parent: TableModel | undefined
	/** The table that owns the dimension an insert or a move targets: the container's table, or a child's parent. */
	readonly destination: TableModel | undefined
	readonly shape: TableShape
	readonly joins: Readonly<Record<string, readonly ForeignKeyPair[]>>
	/** The model of each child a select may join, by its table name. */
	readonly children: Readonly<Record<string, TableModel>>
	readonly connection: Connection
}

/** The dialect of the database the layer is bound to: what a read answers and a write binds depends on it. */
export function dialectOf(context: TableContext): SqlDialect {
	return runtimeOf(context.connection).database.dialect
}

/** The columns of `model`'s own rows that a read answers in a form of its own (`answerRows`). */
export function rowColumnsOf(model: TableModel): RowColumns {
	return { days: model.dates, timestamps: model.timestamps, booleans: model.booleans }
}

/** A timestamp's bound value on SQLite: its stored UTC text. Postgres takes a `Date` or ISO text as it is. */
function boundTimestamp(model: TableModel, column: string, value: Primitive): Primitive {
	if (typeof value !== 'string' && !(value instanceof Date)) {
		throw new QueryRefusedError('invalid_value', `${model.name}.${column} takes a Date or ISO 8601 text with Z or an offset`)
	}
	return storedTimestamp(value, `${model.name}.${column}`)
}

/** The values a write binds: on SQLite each timestamp as its stored UTC text, so text order is time order. */
export function boundValues(context: TableContext, values: ReadonlyMap<string, Primitive | null>): ReadonlyMap<string, Primitive | null> {
	const model = context.model
	if (dialectOf(context) === 'postgres' || ownKeys(model.timestamps).length === 0) {
		return values
	}
	const bound = new Map<string, Primitive | null>()
	for (const [name, value] of values) {
		bound.set(name, value === null || !inSet(model.timestamps, name) ? value : boundTimestamp(model, name, value))
	}
	return bound
}

/** A term's values as they are bound: on SQLite, one over a timestamp of `model` compares stored UTC text. */
function boundTerm(model: TableModel, term: Compare | Contains): Compare | Contains {
	const value = term.kind === 'compare' ? term.value : null
	if (term.kind !== 'compare' || value === null || !inSet(model.timestamps, term.column)) {
		return term
	}
	const bind = (item: Primitive): Primitive => boundTimestamp(model, term.column, item)
	return { ...term, value: isList(value) ? value.map(bind) : bind(value) }
}

function isList(value: Primitive | readonly Primitive[]): value is readonly Primitive[] {
	return isArray(value)
}

/** A list's terms over `model`'s columns, as `boundTerm` binds each. */
export function boundTerms(context: TableContext, model: TableModel, terms: readonly (Compare | Contains)[]): readonly (Compare | Contains)[] {
	if (dialectOf(context) === 'postgres' || ownKeys(model.timestamps).length === 0) {
		return terms
	}
	return terms.map((term) => boundTerm(model, term))
}

/** A description's conditions over `model`'s columns, an OR group's terms included, as `boundTerm` binds each. */
function boundConditions(context: TableContext, model: TableModel, conditions: readonly Condition[]): readonly Condition[] {
	if (dialectOf(context) === 'postgres' || ownKeys(model.timestamps).length === 0) {
		return conditions
	}
	return conditions.map((condition) =>
		condition.kind === 'any' ? { ...condition, conditions: condition.conditions.map((term) => boundTerm(model, term)) } : boundTerm(model, condition)
	)
}

/** A select's conditions, its joined children's included, as they are bound. */
function boundState(context: TableContext, state: SelectState): SelectState {
	if (dialectOf(context) === 'postgres') {
		return state
	}
	const joins = state.joins.map((join) => {
		const child = ownEntry(context.children, join.join.shape.table)
		return child === undefined ? join : { ...join, select: { ...join.select, conditions: boundConditions(context, child, join.select.conditions) } }
	})
	return { ...state, conditions: boundConditions(context, context.model, state.conditions), joins }
}

export function runtimeOf(connection: Connection): DataLayerRuntime {
	const runtime = connection.runtime
	if (runtime === undefined) {
		throw new CapabilityError(
			'layer_unbound',
			'the data layer is not connected: the framework connects it at boot, so a store runs inside a handler, never while a module loads',
		)
	}
	return runtime
}

export interface DimensionScopeModel {
	readonly dimension: string
	readonly key: string
	readonly container: Container | undefined
}

export function dimensionScope(model: TableModel): DimensionScopeModel {
	if (model.scope.mode !== 'dimension') {
		throw new CapabilityError('table_kind', `${model.name} is not a dimension table`)
	}
	return model.scope
}

export function childScope(context: TableContext): { readonly key: string; readonly column: string; readonly parent: DimensionScopeModel } {
	const scope = context.model.scope
	if (scope.mode !== 'child' || context.parent === undefined) {
		throw new CapabilityError('table_kind', `${context.model.name} is not a child table`)
	}
	return { key: scope.key, column: scope.column, parent: dimensionScope(context.parent) }
}

/** The dimension that lists and inserts are scoped by: the container, or for a top-level table its own. */
export function listDimension(scope: DimensionScopeModel): string {
	return scope.container?.dimension ?? scope.dimension
}

/** The actions that allow `operation` on the table, any one of them; throws when its policy declares none. */
export function requiredActions(context: TableContext, operation: Operation): readonly string[] {
	const actions = context.model.actions[operation]
	if (actions.length === 0) {
		throw new CapabilityError('undeclared_operation', `${context.model.name} allows no ${operation}; its policy declares no ${operation} action`)
	}
	return actions
}

/** Refuses a capability whose action is not one of `operation`'s actions on the table. */
export function checkAction(context: TableContext, operation: Operation, action: string): void {
	const actions = requiredActions(context, operation)
	if (!includes(actions, action)) {
		throw new CapabilityError('wrong_action', `${operation} on ${context.model.name} requires ${actions.join(' or ')}; the capability holds ${action}`)
	}
}

function checkGrant(context: TableContext, grant: RefGrant | WithinGrant, dimension: string, operation: Operation): void {
	requiredActions(context, operation)
	if (grant.dimension !== dimension) {
		throw new CapabilityError(
			'wrong_capability',
			`${operation} on ${context.model.name} needs a ${grant.kind} of ${dimension}, got a ${grant.kind} of ${grant.dimension}`,
		)
	}
	checkAction(context, operation, grant.action)
}

function refGrant(context: TableContext, capability: unknown, dimension: string, operation: Operation): RefGrant {
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	if (grant.kind !== 'ref') {
		throw new CapabilityError('wrong_capability', `${operation} on ${context.model.name} needs a Ref of ${dimension}, got ${describeGrant(grant)}`)
	}
	checkGrant(context, grant, dimension, operation)
	return grant
}

function withinGrant(context: TableContext, capability: unknown, dimension: string, operation: Operation): WithinGrant {
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	if (grant.kind !== 'within') {
		throw new CapabilityError('wrong_capability', `${operation} on ${context.model.name} needs a Within of ${dimension}, got ${describeGrant(grant)}`)
	}
	checkGrant(context, grant, dimension, operation)
	return grant
}

/** The chain links that lie above the `Within`'s own dimension: the only columns a container grant may filter on. */
function linksAbove(model: TableModel, dimension: string): readonly Container[] {
	for (let index = 0; index < model.chain.length; index++) {
		if (model.chain[index]?.dimension === dimension) {
			const above: Container[] = []
			for (let position = index + 1; position < model.chain.length; position++) {
				const link = model.chain[position]
				if (link !== undefined) {
					above[above.length] = link
				}
			}
			return above
		}
	}
	return []
}

/**
 * `column in (values) or <container column> in (container values) …`, one disjunct per container dimension, so
 * the statement itself judges each row by the chain it carries now. Undefined for an empty `Within`: the caller
 * answers `[]` without a query.
 */
function withinPredicate(model: TableModel, column: string, grant: WithinGrant): OperationNode | undefined {
	if (grant.values === 'all') {
		return everything()
	}
	const above = linksAbove(model, grant.dimension)
	const predicates: OperationNode[] = []
	let count = grant.values.length
	if (grant.values.length > 0) {
		predicates[predicates.length] = inList(model.name, column, grant.values)
	}
	for (let index = 0; index < grant.containers.length; index++) {
		const container = grant.containers[index]
		if (container === undefined) {
			continue
		}
		let link: Container | undefined
		for (let position = 0; position < above.length; position++) {
			if (above[position]?.dimension === container.dimension) {
				link = above[position]
			}
		}
		if (link === undefined) {
			throw new CapabilityError(
				'unenforceable',
				`the Within of ${grant.dimension} reaches through ${container.dimension}, which ${model.name} carries no column for above ${grant.dimension}; the layer cannot enforce it`,
			)
		}
		count += container.values.length
		if (container.values.length > 0) {
			predicates[predicates.length] = inList(model.name, link.column, container.values)
		}
	}
	if (count > MAX_WITHIN_VALUES) {
		throw new CapabilityError('within_size', `a Within carries at most ${MAX_WITHIN_VALUES} scope values; this one carries ${count}`)
	}
	return predicates.length === 0 ? undefined : anyOf(predicates)
}

/** The object a Ref of the model's own dimension names, with every link of its chain. */
export function selfLinks(model: TableModel): readonly Container[] {
	const scope = dimensionScope(model)
	return [{ dimension: scope.dimension, column: scope.key }, ...model.chain]
}

/** This object, over the whole chain the Ref carries. */
export function objectPredicate(context: TableContext, capability: unknown, operation: Operation): OperationNode {
	const scope = dimensionScope(context.model)
	const grant = refGrant(context, capability, scope.dimension, operation)
	return linksPredicate(context.model.name, linkValues(context.model.name, selfLinks(context.model), grant))
}

/** Rows of a dimension table within the scope values of its list dimension. */
export function dimensionListPredicate(context: TableContext, capability: unknown, operation: Operation): OperationNode | undefined {
	const scope = dimensionScope(context.model)
	const grant = withinGrant(context, capability, listDimension(scope), operation)
	return withinPredicate(context.model, scope.container?.column ?? scope.key, grant)
}

/** Rows of a child table that belong to the parent object the Ref names, over the whole chain. */
export function parentPredicate(context: TableContext, grant: RefGrant): OperationNode {
	return linksPredicate(context.model.name, linkValues(context.model.name, context.model.chain, grant))
}

export function childListPredicate(context: TableContext, capability: unknown, operation: Operation): OperationNode | undefined {
	const scope = childScope(context)
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	if (grant.kind === 'ref') {
		checkGrant(context, grant, scope.parent.dimension, operation)
		return parentPredicate(context, grant)
	}
	if (grant.kind === 'app' || grant.kind === 'row') {
		throw new CapabilityError('wrong_capability', `a list of ${context.model.name} by its parent needs a Ref or a Within, got ${describeGrant(grant)}`)
	}
	checkGrant(context, grant, listDimension(scope.parent), operation)
	return withinPredicate(context.model, scope.parent.container?.column ?? scope.column, grant)
}

/**
 * The column that places a row of `model` in `dimension`: the column of that link of its containment chain, or a
 * top-level table's own key; `undefined` when no `Within` of the dimension reaches the table.
 */
export function reachColumn(model: TableModel, dimension: string): string | undefined {
	if (model.scope.mode === 'dimension' && model.scope.container === undefined && model.scope.dimension === dimension) {
		return model.scope.key
	}
	for (let index = 0; index < model.chain.length; index++) {
		const link = model.chain[index]
		if (link?.dimension === dimension) {
			return link.column
		}
	}
	return undefined
}

/**
 * Rows of a table a `Within` of any dimension of its chain lists, by the table's read action: tasks under a `Within` of
 * `org` through their stamped `org_id`, as under one of `project` through `project_id`.
 */
export function reachPredicate(context: TableContext, capability: unknown): OperationNode | undefined {
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	const table = context.model.name
	if (grant.kind !== 'within') {
		throw new CapabilityError('wrong_capability', `a list of ${table} needs a Within, got ${describeGrant(grant)}`)
	}
	checkAction(context, 'read', grant.action)
	const column = reachColumn(context.model, grant.dimension)
	if (column === undefined) {
		throw new CapabilityError(
			'out_of_reach',
			`a Within of ${grant.dimension} does not reach ${table}: its containment chain does not hold ${grant.dimension}`,
		)
	}
	return withinPredicate(context.model, column, grant)
}

/**
 * A fragment on an UPDATE or DELETE target: the capability's action is that operation's, and an application table is
 * written by an `app` capability only, a dimension or child table never by one. An UPDATE may instead hold a column's
 * own write action when every column it assigns declares that action (`updatingRef`'s rule); `assigned` is
 * `undefined` before the statement is known, and then any such action is taken.
 */
function checkWriteTarget(context: TableContext, grant: CapabilityGrant, use: 'update' | 'delete', assigned: readonly string[] | undefined): void {
	const model = context.model
	const statement = `${use === 'update' ? 'UPDATE' : 'DELETE'} of ${model.name}`
	if (grant.kind === 'app' && model.scope.mode !== 'app') {
		throw new CapabilityError('table_kind', `an app capability writes application tables only: ${statement} needs a Ref or a Within`)
	}
	if (grant.kind !== 'app' && model.scope.mode === 'app') {
		throw new CapabilityError('table_kind', `a scoped site writes no application table: ${statement} needs the capability of an app endpoint`)
	}
	const actions = model.actions[use]
	if (includes(actions, grant.action)) {
		return
	}
	const columnWrites: string[] = []
	const updates = use === 'update' ? updateActions(model) : []
	for (let index = 0; index < updates.length; index++) {
		const write = updates[index]
		if (write !== undefined && !includes(actions, write)) columnWrites[columnWrites.length] = write
	}
	if (actions.length === 0 && columnWrites.length === 0) {
		throw new CapabilityError('undeclared_operation', `${statement}: its policy declares no ${use} action`)
	}
	if (!includes(columnWrites, grant.action)) {
		const needs = actions.length === 0 ? [] : [`its ${use} action ${actions.join(' or ')}`]
		if (columnWrites.length > 0) needs[needs.length] = `a column's own write action (${columnWrites.join(', ')})`
		throw new CapabilityError('wrong_action', `${statement} needs ${needs.join(' or ')}; the capability holds ${grant.action}`)
	}
	if (assigned === undefined) {
		return
	}
	const written = updatableBy(model, grant.action)
	const outside: string[] = assigned.length === 0 ? ['no column it can name'] : []
	for (let index = 0; index < assigned.length; index++) {
		const column = assigned[index]
		if (column !== undefined && !inSet(written, column)) outside[outside.length] = column
	}
	if (outside.length > 0) {
		throw new CapabilityError(
			'wrong_action',
			`${statement} assigns ${
				outside.join(', ')
			}, which ${grant.action} does not write: a column's own write action scopes an UPDATE of its columns only`,
		)
	}
}

/**
 * `ctx.sql.scope`'s predicate: what the handles of `capability` match in the table for `use`, as column tests. A
 * fragment that reads (`'read'`) needs an action the handles read the table with: any action it names for a `Ref`,
 * its read action for a `Within`, an action `ctx.db.app` lists it for with an `app` capability, and its read action
 * for a scoped site's read of an application table. A fragment on the statement's UPDATE or DELETE target needs that
 * operation's own action, and an `app` capability writes application tables only. A `Ref` matches its object's column
 * and every link of the chain it carries; a `Within` matches like `ctx.db.within` (its values, each container grant on
 * its own column, or every row for `all`); an `app` capability, and a scoped read of an application table, every row.
 */
export function scopeTerms(context: TableContext, capability: unknown, use: ScopeUse, assigned?: readonly string[]): ScopeTerms {
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	const model = context.model
	if (grant.kind === 'row') {
		throw new CapabilityError('wrong_capability', `ctx.sql.scope takes a Ref, a Within or an app capability, got ${describeGrant(grant)}`)
	}
	if (use !== 'read') {
		checkWriteTarget(context, grant, use, assigned)
	}
	if (grant.kind === 'app') {
		if (use === 'read') {
			// The action is held as a global grant, so its scope is every row of a table it reaches.
			checkAppReach(context, grant)
		}
		return 'all'
	}
	if (model.scope.mode === 'app') {
		scopedApplicationRead(context, capability)
		return 'all'
	}
	if (grant.kind === 'ref') {
		const links = model.scope.mode === 'dimension' ? selfLinks(model) : model.chain
		let start = -1
		for (let index = 0; index < links.length && start === -1; index++) {
			if (links[index]?.dimension === grant.dimension) start = index
		}
		if (start === -1) {
			throw new CapabilityError(
				'out_of_reach',
				`a Ref of ${grant.dimension} does not reach ${model.name}: its containment chain does not hold ${grant.dimension}`,
			)
		}
		if (use === 'read' && !namesAction(model, grant.action)) {
			throw new CapabilityError('wrong_action', `${model.name} does not name the action ${grant.action}: a Ref reads it with an action it names`)
		}
		return [linkValues(model.name, links.slice(start), grant).map(({ link, value }) => ({ column: link.column, value }))]
	}
	const column = reachColumn(model, grant.dimension)
	if (column === undefined) {
		throw new CapabilityError(
			'out_of_reach',
			`a Within of ${grant.dimension} does not reach ${model.name}: its containment chain does not hold ${grant.dimension}`,
		)
	}
	if (use === 'read' && !includes(model.actions.read, grant.action)) {
		throw new CapabilityError(
			'wrong_action',
			`a Within of ${grant.action} does not read ${model.name}: it reads with its read action ${model.actions.read.join(' or ')}`,
		)
	}
	if (grant.values === 'all') {
		return 'all'
	}
	const above = linksAbove(model, grant.dimension)
	const groups: ScopeTest[][] = []
	let count = grant.values.length
	if (grant.values.length > 0) {
		groups.push([{ column, value: grant.values }])
	}
	for (const container of grant.containers) {
		const link = above.find((candidate) => candidate.dimension === container.dimension)
		if (link === undefined) {
			throw new CapabilityError(
				'unenforceable',
				`the Within of ${grant.dimension} reaches through ${container.dimension}, which ${model.name} carries no column for above ${grant.dimension}; the layer cannot enforce it`,
			)
		}
		count += container.values.length
		if (container.values.length > 0) {
			groups.push([{ column: link.column, value: container.values }])
		}
	}
	if (count > MAX_WITHIN_VALUES) {
		throw new CapabilityError('within_size', `a Within carries at most ${MAX_WITHIN_VALUES} scope values; this one carries ${count}`)
	}
	return groups
}

/**
 * A `Ref` of `dimension` whose action updates columns of the table: its update action, or a column's own write action.
 * Which columns it updates follows from the action (`updatableBy`).
 */
export function updatingRef(context: TableContext, capability: unknown, dimension: string): RefGrant {
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	const table = context.model.name
	if (grant.kind !== 'ref') {
		throw new CapabilityError('wrong_capability', `update on ${table} needs a Ref of ${dimension}, got ${describeGrant(grant)}`)
	}
	if (grant.dimension !== dimension) {
		throw new CapabilityError('wrong_capability', `update on ${table} needs a ref of ${dimension}, got a ref of ${grant.dimension}`)
	}
	const actions = updateActions(context.model)
	if (actions.length === 0) {
		throw new CapabilityError('undeclared_operation', `${table} allows no update; its policy declares no update action`)
	}
	for (let index = 0; index < actions.length; index++) {
		if (actions[index] === grant.action) {
			return grant
		}
	}
	throw new CapabilityError('wrong_action', `update on ${table} requires ${actions.join(' or ')}; the capability holds ${grant.action}`)
}

/**
 * What an `app` capability reaches of a dimension or child table: its rows (`list`, a scope fragment) with the read
 * action or an action of `appRead`; its counts (`count`, `aggregate`) with those or an action of `appCount`.
 */
export type AppReach = 'rows' | 'counts'

/** Refuses an `app` capability whose action does not reach `reach` of a dimension or child table. */
function checkRecordReach(context: TableContext, grant: AppGrant, reach: AppReach): void {
	const model = context.model
	const { appRead, appCount } = model.actions
	const read = model.actions.read.join(' or ')
	if (
		includes(model.actions.read, grant.action) || includes(appRead, grant.action) || (reach === 'counts' && includes(appCount, grant.action))
	) {
		return
	}
	if (includes(appCount, grant.action)) {
		throw new CapabilityError(
			'wrong_action',
			`an app capability of ${grant.action} only counts ${model.name} (its appCount): it reads no row, so list, aggregate and a scope fragment need its read action ${read}${
				appRead.length === 0 ? '' : ` or one of its appRead (${appRead.join(', ')})`
			}`,
		)
	}
	throw new CapabilityError(
		'wrong_action',
		`an app capability of ${grant.action} does not reach ${model.name}: ctx.db.app lists it for its read action ${read}${
			appRead.length === 0 ? '' : ` or one of its appRead (${appRead.join(', ')})`
		} only`,
	)
}

/**
 * Refuses a table `ctx.db.app` does not list for the capability (`applicationTables` in `orm.ts`): it lists an
 * application table under any action the table names, and the rows of a dimension or child table under its read
 * action or an action of its `appRead`.
 */
function checkAppReach(context: TableContext, grant: AppGrant): void {
	const model = context.model
	const mode = model.scope.mode
	if (mode === 'app') {
		if (!namesAction(model, grant.action)) {
			throw new CapabilityError(
				'wrong_action',
				`an app capability of ${grant.action} does not reach ${model.name}: ${model.name} does not name the action`,
			)
		}
		return
	}
	if (mode !== 'dimension' && mode !== 'child') {
		throw new CapabilityError(
			'table_kind',
			`an app capability does not reach ${model.name}: ctx.db.app lists application, dimension and child tables only`,
		)
	}
	checkRecordReach(context, grant, 'rows')
}

/**
 * Every row of a dimension or child table an `app` capability reads through `ctx.db.app`: `true`, for an action that
 * reaches `reach` (`checkRecordReach`).
 */
export function appRecordPredicate(context: TableContext, capability: unknown, reach: AppReach): OperationNode {
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	const model = context.model
	if (grant.kind !== 'app') {
		throw new CapabilityError(
			'wrong_capability',
			`a read of ${model.name} through ctx.db.app needs the capability of an app endpoint, got ${describeGrant(grant)}`,
		)
	}
	if (model.scope.mode !== 'dimension' && model.scope.mode !== 'child') {
		throw new CapabilityError('table_kind', `${model.name} is not a dimension or child table`)
	}
	checkRecordReach(context, grant, reach)
	return everything()
}

/** An `app` capability addresses a row by its key, and writes, only in an application table. */
function checkApplicationTable(context: TableContext, operation: Operation): void {
	if (context.model.scope.mode !== 'app') {
		throw new CapabilityError(
			'table_kind',
			`${operation} of a ${context.model.name} row needs a Ref: an app capability addresses and writes application tables only`,
		)
	}
}

/**
 * The capability of an `app` endpoint for `operation` on `table`: its action is that operation's. An application table
 * is written with it, and a dimension or child table read with it.
 */
function appGrant(context: TableContext, capability: unknown, operation: Operation): AppGrant {
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	const table = context.model.name
	if (grant.kind !== 'app') {
		throw new CapabilityError('wrong_capability', `${operation} on ${table} here needs the capability of an app endpoint, got ${describeGrant(grant)}`)
	}
	if (operation !== 'read') {
		checkApplicationTable(context, operation)
	}
	checkAppReach(context, grant)
	checkAction(context, operation, grant.action)
	return grant
}

/** Every row a capability of an `app` endpoint reads in `table`, by the table's read action: `true`. */
export function appListPredicate(context: TableContext, capability: unknown): OperationNode {
	appGrant(context, capability, 'read')
	return everything()
}

/**
 * Every row of an application table, for a `Ref` or a `Within` of its read action: what `ctx.db.app` of an `on`, `in`
 * or `over` endpoint reads, read-only, as a reference table is read. The table's read action decides who reads it.
 */
export function scopedApplicationRead(context: TableContext, capability: unknown): OperationNode {
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	const model = context.model
	if (model.scope.mode !== 'app') {
		throw new CapabilityError('table_kind', `${model.name} is not an application table: a scoped site reads it through its own handles`)
	}
	if (grant.kind === 'app') {
		throw new CapabilityError('wrong_capability', `a read of ${model.name} from a scoped site needs a Ref or a Within, got ${describeGrant(grant)}`)
	}
	const read = requiredActions(context, 'read')
	if (!includes(read, grant.action)) {
		throw new CapabilityError(
			'wrong_action',
			`a scoped site reads ${model.name} with its read action ${read.join(' or ')} only; the capability holds ${grant.action}`,
		)
	}
	return everything()
}

/** One row of an application table by its key, for an `app` capability of `operation`'s action. */
export function appRowPredicate(context: TableContext, capability: unknown, key: unknown, operation: Operation): OperationNode {
	checkApplicationTable(context, operation)
	appGrant(context, capability, operation)
	return appKeyPredicate(context.model, key)
}

/**
 * What a claim of a queue table leases through `capability`: an application table's every row for an `app` capability,
 * a dimension or child table's rows a `Within` lists. Either way its action is one of the table's update actions.
 */
export function claimScope(
	context: TableContext,
	capability: unknown,
): { readonly grant: AppGrant | WithinGrant; readonly scope: OperationNode | undefined } {
	const model = context.model
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	if (model.queue === undefined) {
		throw new CapabilityError('undeclared_operation', `${model.name} is not a queue table: its policy declares no queue`)
	}
	if (grant.kind === 'app') {
		return { grant: appGrant(context, capability, 'update'), scope: everything() }
	}
	if (grant.kind !== 'within') {
		throw new CapabilityError('wrong_capability', `a claim of ${model.name} needs a Within or an app capability, got ${describeGrant(grant)}`)
	}
	if (model.scope.mode === 'app') {
		throw new CapabilityError('table_kind', `${model.name} is an application table: claim it through ctx.db.app`)
	}
	checkAction(context, 'update', grant.action)
	const column = reachColumn(model, grant.dimension)
	if (column === undefined) {
		throw new CapabilityError(
			'out_of_reach',
			`a Within of ${grant.dimension} does not reach ${model.name}: its containment chain does not hold ${grant.dimension}`,
		)
	}
	return { grant, scope: withinPredicate(model, column, grant) }
}

/**
 * The one row a claim's `row.ref` names, for an action of `operation`: its key and every containment column it had when
 * it was claimed, so a row moved since is not reached.
 */
export function claimedRowPredicate(context: TableContext, capability: unknown, operation: 'update' | 'delete'): OperationNode {
	const model = context.model
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	if (grant.kind !== 'row' || grant.table !== model.name) {
		throw new CapabilityError('wrong_capability', `${operation} of a claimed ${model.name} row needs its row.ref, got ${describeGrant(grant)}`)
	}
	checkAction(context, operation, grant.action)
	const terms: OperationNode[] = [equals(model.name, keyOf(model), grant.id)]
	for (let index = 0; index < model.chain.length; index++) {
		const link = model.chain[index]
		const value = link === undefined ? undefined : grant.chain.get(link.column)
		if (link === undefined || value === undefined) {
			throw new CapabilityError('unenforceable', `the row.ref of ${model.name} carries no ${link?.column ?? 'containment'} value`)
		}
		terms[terms.length] = equals(model.name, link.column, value)
	}
	return allOf(terms)
}

/** The row of an application table `key` names. */
export function appKeyPredicate(model: TableModel, key: unknown): OperationNode {
	if (typeof key !== 'string' || key.length === 0) {
		throw new QueryRefusedError('row_address', `a ${model.name} row is addressed by its ${keyOf(model)}, a non-empty string`)
	}
	return equals(model.name, keyOf(model), key)
}

/**
 * The capability of an `app` endpoint whose action updates columns of an application table: its update action, or a
 * column's own write action. Which columns it updates follows from the action (`updatableBy`).
 */
export function updatingApp(context: TableContext, capability: unknown): AppGrant {
	const grant = runtimeOf(context.connection).capabilities.resolve(capability)
	const table = context.model.name
	if (grant.kind !== 'app') {
		throw new CapabilityError('wrong_capability', `update on ${table} needs the capability of an app endpoint, got ${describeGrant(grant)}`)
	}
	checkApplicationTable(context, 'update')
	const actions = updateActions(context.model)
	if (actions.length === 0) {
		throw new CapabilityError('undeclared_operation', `${table} allows no update; its policy declares no update action`)
	}
	for (let index = 0; index < actions.length; index++) {
		if (actions[index] === grant.action) {
			return grant
		}
	}
	throw new CapabilityError('wrong_action', `update on ${table} requires ${actions.join(' or ')}; the capability holds ${grant.action}`)
}

export function childObjectPredicate(context: TableContext, parent: unknown, key: unknown, operation: Operation): OperationNode {
	const scope = childScope(context)
	if (typeof key !== 'string' || key.length === 0) {
		throw new QueryRefusedError('row_address', `a ${context.model.name} row is addressed by its parent Ref and its ${scope.key}`)
	}
	const grant = refGrant(context, parent, scope.parent.dimension, operation)
	return allOf([equals(context.model.name, scope.key, key), parentPredicate(context, grant)])
}

export function guard(context: TableContext, root: RootKind, scope: OperationNode | undefined): GuardContext {
	return { root, table: context.model.name, joins: root === 'SelectQueryNode' ? context.joins : {}, scope }
}

/**
 * Where a table operation's statements run: a store's own sessions, one transaction per mutation, or the mini-ORM's
 * invocation transaction (`orm.ts`), where every statement of a handler runs in one.
 */
export interface Runner {
	/** The session a read runs in. */
	read(): Promise<Session>
	/** Runs `work` in one transaction. */
	write<T>(work: (transaction: Session) => Promise<T>): Promise<T>
	/** Where file references are made and checked; a store's own runner has none, and its file columns read as ids. */
	readonly files?: FileBinding
}

/**
 * Every mutation of a store runs in its own transaction. In a job attempt that transaction is fenced by the attempt's
 * lease (`fencedTransaction`): an attempt that lost it, or ran out of time, writes nothing.
 */
export function fencedWork<T>(runtime: DataLayerRuntime, work: (transaction: Session) => Promise<T>): Promise<T> {
	const fence = runtime.capabilities.fence()
	const session = sessionOf(runtime)
	return fence === null ? session.transaction(work) : fencedTransaction(session, fence, work)
}

/** The action a capability holds, which its operation's checks already admitted. */
export function heldAction(context: TableContext, capability: unknown): string {
	return runtimeOf(context.connection).capabilities.resolve(capability).action
}

function storeRunner(context: TableContext): Runner {
	return {
		read: async () => sessionOf(runtimeOf(context.connection)),
		write: (work) => fencedWork(runtimeOf(context.connection), work),
	}
}

/**
 * Reads insert or update data through its own property descriptors, so no getter runs and no inherited or
 * non-enumerable key slips past. Every key is checked before any value is read; unknown keys are refused, not
 * dropped, so an agent learns about them.
 */
export function readValues(values: unknown, allowed: NameSet, what: 'insert' | 'update', model: TableModel): Map<string, Primitive | null> {
	const table = model.name
	if (typeof values !== 'object' || values === null || isArray(values)) {
		throw new QueryRefusedError('invalid_argument', `${what} takes an object of column values`)
	}
	const prototype: unknown = prototypeOf(values)
	if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
		throw new QueryRefusedError('invalid_argument', `${what} takes a plain object literal, not an instance of a class`)
	}
	if (ownSymbols(values).length > 0) {
		throw new QueryRefusedError('invalid_argument', `${what} takes column names as keys, not symbols`)
	}
	const keys = ownNames(values)
	const descriptors: PropertyDescriptor[] = []
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		const descriptor = ownDescriptor(values, key)
		if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
			throw new QueryRefusedError('invalid_argument', `${table}.${key} is an accessor; ${what} takes plain values`)
		}
		if (!inSet(allowed, key)) {
			const columns = namesOf(allowed).join(', ') || 'none'
			throw new QueryRefusedError('unknown_column', `${key} is not an ${what} column of ${table} (${what} columns: ${columns})`)
		}
		descriptors[index] = descriptor
	}
	const copied = new Map<string, Primitive | null>()
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		const value: unknown = descriptors[index]?.value
		if (value === undefined) {
			continue
		}
		if (hasOwn(model.files, key)) {
			copied.set(key, fileValue(model, key, value))
			continue
		}
		if (value !== null && !isPrimitive(value)) {
			throw new QueryRefusedError('invalid_argument', `${table}.${key} takes a plain value (string, number, bigint, boolean, Date or null)`)
		}
		copied.set(key, typeof value === 'string' ? temporalText(model, key, value) : value)
	}
	return copied
}

/** A day's or a timestamp's text, checked before it is bound; any other column's text as it is. */
function temporalText(model: TableModel, column: string, value: string): string {
	if (inSet(model.dates, column)) {
		return dayInput(value, `${model.name}.${column}`)
	}
	return inSet(model.timestamps, column) ? timestampInput(value, `${model.name}.${column}`) : value
}

function stampInsert(
	context: TableContext,
	grant: { readonly principal: string },
	values: Map<string, Primitive | null>,
	key: string,
	keyValue: string,
): void {
	values.set(key, keyValue)
	if (context.model.version !== undefined) {
		values.set(context.model.version, 1)
	}
	if (context.model.createdBy !== undefined) {
		values.set(context.model.createdBy, grant.principal)
	}
}

export function versionArgument(context: TableContext, options: readonly unknown[]): OperationNode | undefined {
	const version = context.model.version
	if (version === undefined) {
		return undefined
	}
	const first = options[0]
	const expected: unknown = typeof first === 'object' && first !== null ? Reflect.get(first, 'expectVersion') : undefined
	if (typeof expected !== 'number' || !isSafeInteger(expected)) {
		throw new QueryRefusedError('version_required', `${context.model.name} has a version column; update and remove take { expectVersion: number }`)
	}
	return BinaryOperationNode.create(column(context.model.name, version), OperatorNode.create('='), ValueNode.create(expected))
}

async function selectRows<S>(
	context: TableContext,
	scope: OperationNode | undefined,
	state: SelectState,
	action: string,
	visible: readonly string[] = context.model.visible,
): Promise<S[]> {
	const run = storeRunner(context)
	for (let index = 0; index < state.joins.length; index++) {
		const join = state.joins[index]
		if (join !== undefined && !includes(join.join.readActions, action)) {
			throw new CapabilityError(
				'wrong_action',
				`joining ${join.join.shape.table} requires ${join.join.readActions.join(' or ')}; the capability holds ${action}`,
			)
		}
	}
	if (scope === undefined) {
		return []
	}
	const dialect = dialectOf(context)
	const node = selectNode(boundState(context, state), visible, scope, undefined, context.model.dates, dialect)
	const rows = await (await run.read()).run<S>(node, guard(context, 'SelectQueryNode', scope))
	return answerRows(dialect, context.model.name, joinedColumns(context, state), rows)
}

/** The column sets of a select's rows: the table's own, and each joined child's under its `<child>.<column>` alias. */
function joinedColumns(context: TableContext, state: SelectState): RowColumns {
	const own = rowColumnsOf(context.model)
	if (state.joins.length === 0) {
		return own
	}
	const joined = (pick: (columns: RowColumns) => NameSet): NameSet => {
		const names: string[] = []
		const owned = namesOf(pick(own))
		for (let index = 0; index < owned.length; index++) {
			names[names.length] = owned[index] ?? ''
		}
		for (let index = 0; index < state.joins.length; index++) {
			const table = state.joins[index]?.join.shape.table ?? ''
			const child = ownEntry(context.children, table)
			const columns = child === undefined ? [] : namesOf(pick(rowColumnsOf(child)))
			for (let position = 0; position < columns.length; position++) {
				names[names.length] = `${table}.${columns[position]}`
			}
		}
		return nameSet(names)
	}
	return {
		days: joined((columns) => columns.days),
		timestamps: joined((columns) => columns.timestamps),
		booleans: joined((columns) => columns.booleans),
	}
}

/**
 * One row by its scope predicate, with `visible` columns (the table's read action's, unless a capability reads its own).
 * `action` is what read it: each file column then answers a reference that reads the file only under a read action.
 */
export async function selectOne<O>(
	context: TableContext,
	run: Runner,
	scope: OperationNode,
	visible = context.model.visible,
	action?: string,
): Promise<O> {
	const start = startSelect(context.shape)
	const state = finishSelect(start, start)
	const dialect = dialectOf(context)
	const node = selectNode(state, visible, scope, undefined, context.model.dates, dialect)
	const session = await run.read()
	const rows = await session.run<O>(node, guard(context, 'SelectQueryNode', scope))
	const [row] = answerRows(dialect, context.model.name, rowColumnsOf(context.model), rows)
	if (row === undefined) {
		throw new NotFoundError(`${context.model.name} not found`)
	}
	if (action !== undefined) {
		await answerFiles(context.model, run.files, session, [row], action)
	}
	return row
}

/** The file references an insert wrote, in its transaction: stamped with the scope of the row's own values. */
async function referenceInserted(
	context: TableContext,
	run: Runner,
	transaction: Session,
	values: ReadonlyMap<string, Primitive | null>,
): Promise<void> {
	const model = context.model
	await referenceFiles(model, run.files, transaction, values, async () => {
		const scope = rowScope(model, values)
		if (scope === undefined) {
			throw new QueryRefusedError('unexpected_row', `an insert into ${model.name} carries no value of its top-level scope`)
		}
		return scope
	})
}

/** The file references an update wrote, in its transaction: stamped with the scope the updated row lies in. */
async function referenceUpdated(
	context: TableContext,
	run: Runner,
	transaction: Session,
	changes: ReadonlyMap<string, Primitive | null>,
	row: unknown,
): Promise<void> {
	const model = context.model
	await referenceFiles(model, run.files, transaction, changes, async () => {
		const key = keyOf(model)
		const value: unknown = typeof row === 'object' && row !== null ? ownDescriptor(row, key)?.value : undefined
		if (typeof value !== 'string') {
			throw new QueryRefusedError('unexpected_row', `an update of ${model.name} answered no ${key}`)
		}
		return storedRowScope(model, transaction, key, value)
	})
}

export function answer(context: TableContext): ReturningNode {
	return acknowledgement(context.model.name, keyOf(context.model), context.model.version)
}

/** Throws inside the mutation's transaction, so a table whose version is not an INTEGER keeps nothing written. */
function checkVersion(context: TableContext, row: unknown): void {
	const version = context.model.version
	if (version === undefined) {
		return
	}
	const value: unknown = typeof row === 'object' && row !== null ? Reflect.get(row, 'version') : undefined
	if (typeof value !== 'number' || !isSafeInteger(value)) {
		throw new PolicyError(
			`${context.model.name}.${version} came back as ${typeof value}; a version column must be INTEGER (int4), which Postgres returns as a number`,
		)
	}
}

export function keyOf(model: TableModel): string {
	if (model.scope.mode !== 'dimension' && model.scope.mode !== 'child' && model.scope.mode !== 'app') {
		throw new CapabilityError('undeclared_operation', `${model.name} is not written by handlers`)
	}
	return model.scope.key
}

/**
 * Locks the destination row `for share` and checks that it still lies where the Ref's chain says. Without it, a
 * Ref minted before its object moved would insert into, or move rows into, the object's new container.
 */
async function lockDestination(transaction: Session, context: TableContext, grant: RefGrant): Promise<void> {
	const owner = context.destination
	if (owner === undefined) {
		return
	}
	const scope = linksPredicate(owner.name, linkValues(owner.name, selfLinks(owner), grant))
	const node = lockNode(owner.name, keyOf(owner), scope)
	const rows = await transaction.run(node, { root: 'SelectQueryNode', table: owner.name, joins: {}, scope, lock: 'share' })
	if (rows.length === 0) {
		throw new NotFoundError(`${owner.name} ${grant.id} is not where its Ref says; obtain a fresh Ref`)
	}
}

export async function insertRow<O>(
	context: TableContext,
	run: Runner,
	given: ReadonlyMap<string, Primitive | null>,
	destination: RefGrant | undefined,
): Promise<O> {
	const values = boundValues(context, given)
	return run.write(async (transaction) => {
		if (destination !== undefined) {
			await lockDestination(transaction, context, destination)
		}
		const [row] = await transaction.run<O>(insertNode(context.model.name, values, answer(context)), guard(context, 'InsertQueryNode', undefined))
		if (row === undefined) {
			throw new QueryRefusedError('unexpected_row', `the insert into ${context.model.name} returned no row`)
		}
		checkVersion(context, row)
		await referenceInserted(context, run, transaction, values)
		return row
	})
}

/**
 * `insert(values, { onConflict: { columns, do } })`: on a conflict of `columns` (a unique index of the table), `nothing`
 * writes nothing and `update` sets the columns the table's update action writes, from `updates`.
 */
export interface OnConflict {
	readonly columns: readonly string[]
	readonly mode: 'nothing' | 'update'
	/** The values given for the table's update columns: what `update` sets on the conflicting row. */
	readonly updates: ReadonlyMap<string, Primitive | null>
}

const CONFLICT_FIELDS = nameSet(['columns', 'do'])

/**
 * The `onConflict` of an insert's options, read through own data properties; `undefined` without options. `'update'`
 * also needs the capability's action to be one of the table's update actions.
 */
export function onConflictOf(
	context: TableContext,
	options: unknown,
	action: string,
	given: ReadonlyMap<string, Primitive | null>,
): OnConflict | undefined {
	if (options === undefined) {
		return undefined
	}
	const model = context.model
	const read = plainOptions(options, nameSet(['onConflict']), 'insert')
	const input = ownEntry(read, 'onConflict')
	if (input === undefined) {
		return undefined
	}
	const conflict = plainOptions(input, CONFLICT_FIELDS, 'onConflict')
	const columns = parseList(ownEntry(conflict, 'columns'), (name) => {
		if (!inSet(model.columns, name)) {
			throw new QueryRefusedError('on_conflict', `onConflict names ${String(name)}, which is not a column of ${model.name}`)
		}
		return name
	})
	if (columns === undefined || columns.length === 0) {
		throw new QueryRefusedError('on_conflict', 'onConflict.columns takes a plain array of the columns of a unique index')
	}
	const mode = ownEntry(conflict, 'do')
	if (mode !== 'nothing' && mode !== 'update') {
		throw new QueryRefusedError('on_conflict', "onConflict.do takes 'nothing' or 'update'")
	}
	const updates = new Map<string, Primitive | null>()
	if (mode === 'update') {
		if (!includes(model.actions.update, action)) {
			throw new CapabilityError(
				'wrong_action',
				`an insert of ${model.name} that updates on a conflict also needs its update action ${
					model.actions.update.join(' or ') || '(none)'
				}; the capability holds ${action}`,
			)
		}
		const columns = namesOf(model.update)
		for (let index = 0; index < columns.length; index++) {
			const name = columns[index] ?? ''
			const value = given.get(name)
			if (value !== undefined) {
				updates.set(name, value)
			}
		}
	}
	return freeze({ columns: freeze(columns), mode, updates })
}

/** A plain object's own data properties, each one of `allowed`; the options of an insert or its `onConflict`. */
function plainOptions(value: unknown, allowed: NameSet, what: string): Readonly<Record<string, unknown>> {
	if (typeof value !== 'object' || value === null || isArray(value)) {
		throw new QueryRefusedError('invalid_argument', `${what} takes { ${namesOf(allowed).join(', ')} }`)
	}
	const prototype: unknown = prototypeOf(value)
	if ((prototype !== OBJECT_PROTOTYPE && prototype !== null) || ownSymbols(value).length > 0) {
		throw new QueryRefusedError('invalid_argument', `${what} takes a plain object literal`)
	}
	const copy: Record<string, unknown> = {}
	const keys = ownNames(value)
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		const descriptor = ownDescriptor(value, key)
		if (!inSet(allowed, key)) {
			throw new QueryRefusedError('invalid_argument', `${key} is not an option of ${what} (options: ${namesOf(allowed).join(', ')})`)
		}
		if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
			throw new QueryRefusedError('invalid_argument', `${what}.${key} is an accessor; ${what} takes plain values`)
		}
		setOwn(copy, key, descriptor.value)
	}
	return copy
}

/**
 * The rows an insert's conflict may update: those in the containment the insert stamped (its chain, or a top-level
 * object's own key), or every row of an application table. A conflicting row outside it is never written.
 */
function insertedScope(context: TableContext, values: ReadonlyMap<string, Primitive | null>): OperationNode {
	const model = context.model
	const columns: string[] = []
	for (let index = 0; index < model.chain.length; index++) {
		columns[columns.length] = model.chain[index]?.column ?? ''
	}
	if (model.scope.mode === 'dimension' && model.scope.container === undefined) {
		columns[columns.length] = model.scope.key
	}
	const terms: OperationNode[] = []
	for (let index = 0; index < columns.length; index++) {
		const name = columns[index] ?? ''
		const value = values.get(name)
		if (value === undefined || value === null) {
			throw new QueryRefusedError('on_conflict', `the insert into ${model.name} carries no ${name}`)
		}
		terms[terms.length] = equals(model.name, name, value)
	}
	return terms.length === 0 ? everything() : allOf(terms)
}

/**
 * `insert … on conflict (columns) do nothing`, and for `update` the conflicting row's update in the same transaction,
 * within the insert's own containment. A row deleted between the two is inserted on the second try; a conflicting row
 * the capability does not reach is a 409. Answers `{ id, version?, inserted: true }`, `{ id, version?, inserted:
 * false }` after an update, and `{ inserted: false }` when `nothing` wrote nothing.
 */
async function insertOnConflict(
	context: TableContext,
	run: Runner,
	transaction: Session,
	given: ReadonlyMap<string, Primitive | null>,
	conflict: OnConflict,
): Promise<Readonly<Record<string, unknown>>> {
	const model = context.model
	const values = boundValues(context, given)
	const updates = boundValues(context, conflict.updates)
	const matches: OperationNode[] = []
	for (let index = 0; index < conflict.columns.length; index++) {
		const name = conflict.columns[index] ?? ''
		const value = values.get(name)
		if (value === undefined || value === null) {
			throw new QueryRefusedError('on_conflict', `onConflict names ${name}, which this insert into ${model.name} leaves empty`)
		}
		matches[matches.length] = equals(model.name, name, value)
	}
	const scope = conflict.mode === 'update' ? insertedScope(context, values) : undefined
	for (let attempt = 0; attempt < 2; attempt++) {
		const node = insertNode(model.name, values, answer(context), conflict.columns)
		const [row] = await transaction.run<Readonly<Record<string, unknown>>>(node, {
			...guard(context, 'InsertQueryNode', undefined),
			onConflict: 'nothing',
		})
		if (row !== undefined) {
			checkVersion(context, row)
			await referenceInserted(context, run, transaction, values)
			return { ...row, inserted: true }
		}
		if (scope === undefined) {
			return { inserted: false }
		}
		const where = scopedWhere(allOf(matches), scope)
		const unchanged = updates.size === 0
		const update = unchanged
			? acknowledgementNode(model.name, keyOf(model), model.version, where)
			: updateNode(model.name, updates, model.version, where, answer(context))
		const [updated] = await transaction.run<Readonly<Record<string, unknown>>>(
			update,
			guard(context, unchanged ? 'SelectQueryNode' : 'UpdateQueryNode', scope),
		)
		if (updated !== undefined) {
			checkVersion(context, updated)
			await referenceUpdated(context, run, transaction, updates, updated)
			return { ...updated, inserted: false }
		}
	}
	throw new ConflictError(`${model.name} holds a row with these ${conflict.columns.join(', ')} that this insert does not reach`)
}

/**
 * The rows a write addresses: the scope predicate, and the caller's conditions beside it (an unscoped row's key, whose
 * scope predicate is `true`).
 */
export interface Addressed {
	readonly scope: OperationNode
	readonly conditions?: OperationNode
}

function addressed(scope: OperationNode): Addressed {
	return { scope }
}

function conditionsWith(target: Addressed, expectedVersion: OperationNode | undefined): OperationNode | undefined {
	if (target.conditions === undefined) {
		return expectedVersion
	}
	return expectedVersion === undefined ? target.conditions : allOf([target.conditions, expectedVersion])
}

/** A zero-row write under `expectVersion`: 409 when the row is still there, 404 when it is gone. */
async function missingOrChanged(
	context: TableContext,
	transaction: Session,
	target: Addressed,
	expectedVersion: OperationNode | undefined,
): Promise<never> {
	const table = context.model.name
	if (expectedVersion !== undefined) {
		const node = existsNode(table, keyOf(context.model), target.scope, target.conditions)
		const existing = await transaction.run(node, guard(context, 'SelectQueryNode', target.scope))
		if (existing.length > 0) {
			throw new ConflictError(`${table} was changed by someone else; read it again and retry`)
		}
	}
	throw new NotFoundError(`${table} not found`)
}

/**
 * Zero changed rows → one follow-up read in the same transaction → 404 when the object is gone, else 409. An update
 * that sets no column writes nothing, not even the version: it reads the acknowledgement under the same conditions.
 */
export async function updateRow<O>(
	context: TableContext,
	run: Runner,
	target: Addressed,
	given: ReadonlyMap<string, Primitive | null>,
	expectedVersion: OperationNode | undefined,
	destination?: RefGrant,
): Promise<O> {
	const { name: table, version } = context.model
	const changes = boundValues(context, given)
	const where = scopedWhere(conditionsWith(target, expectedVersion), target.scope)
	const unchanged = changes.size === 0
	const node = unchanged
		? acknowledgementNode(table, keyOf(context.model), version, where)
		: updateNode(table, changes, version, where, answer(context))
	return run.write(async (transaction) => {
		if (destination !== undefined) {
			await lockDestination(transaction, context, destination)
		}
		const [row] = await transaction.run<O>(node, guard(context, unchanged ? 'SelectQueryNode' : 'UpdateQueryNode', target.scope))
		if (row !== undefined) {
			checkVersion(context, row)
			await referenceUpdated(context, run, transaction, changes, row)
			return row
		}
		return missingOrChanged(context, transaction, target, expectedVersion)
	})
}

/** Like `updateRow`: under `expectVersion`, a row that changed is 409 and a missing one 404. */
export async function removeRow(context: TableContext, run: Runner, target: Addressed, expectedVersion?: OperationNode): Promise<void> {
	const node = deleteNode(context.model.name, scopedWhere(conditionsWith(target, expectedVersion), target.scope), keyOf(context.model))
	await run.write(async (transaction) => {
		const rows = await transaction.run(node, guard(context, 'DeleteQueryNode', target.scope))
		if (rows.length === 0) {
			await missingOrChanged(context, transaction, target, expectedVersion)
		}
	})
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

function aggregateColumns(table: string, shape: TableShape, spec: AggregateInput): AggregateColumns {
	const list = (field: string, value: unknown): string[] => {
		if (value === undefined) {
			return []
		}
		const names = parseList(value, (name) => {
			if (!inSet(shape.visible, name)) {
				throw new QueryRefusedError('unknown_column', `${String(name)} is not a column of ${table} (columns: ${namesOf(shape.visible).join(', ')})`)
			}
			return name
		})
		if (names === undefined) {
			throw new QueryRefusedError('invalid_argument', `aggregate ${field} takes a plain array of column names`)
		}
		return names
	}
	const count = spec.count === true
	const columns = { groupBy: list('groupBy', spec.groupBy), count, sum: list('sum', spec.sum), min: list('min', spec.min), max: list('max', spec.max) }
	if (!count && columns.sum.length === 0 && columns.min.length === 0 && columns.max.length === 0) {
		throw new QueryRefusedError('invalid_argument', 'aggregate needs count, sum, min or max')
	}
	return columns
}

function aggregateFilter<Row>(shape: TableShape, where: AggregateSpec<Row>['where']): SelectState | undefined {
	if (where === undefined) {
		return undefined
	}
	if (typeof where !== 'function') {
		throw new QueryRefusedError('invalid_argument', 'aggregate where takes a callback')
	}
	const start = startSelect<Row, NoColumns>(shape)
	const state = finishSelect(where(start), start)
	if (state.columns !== undefined || state.orderBy.length > 0 || state.limit !== undefined || state.offset !== undefined || state.joins.length > 0) {
		throw new QueryRefusedError('invalid_argument', 'aggregate where takes where conditions only')
	}
	return state
}

export async function aggregateRows<Row, O>(
	context: TableContext,
	run: Runner,
	scope: OperationNode | undefined,
	shape: TableShape,
	spec: AggregateSpec<Row>,
): Promise<O[]> {
	if (typeof spec !== 'object' || spec === null) {
		throw new QueryRefusedError('invalid_argument', 'aggregate takes { groupBy, count, sum, min, max, where }')
	}
	const columns = aggregateColumns(context.model.name, shape, spec)
	const filter = aggregateFilter(shape, spec.where)
	if (scope === undefined) {
		return []
	}
	const dialect = dialectOf(context)
	const conditions = boundConditions(context, context.model, filter?.conditions ?? [])
	const node = aggregateNode(context.model.name, columns, conditions, scope, context.model.dates)
	const rows = await (await run.read()).run<O>(node, guard(context, 'SelectQueryNode', scope))
	const own = rowColumnsOf(context.model)
	const answered = answerRows(dialect, context.model.name, {
		days: aggregated(own.days, columns),
		timestamps: aggregated(own.timestamps, columns),
		booleans: aggregated(own.booleans, columns),
	}, rows)
	return dialect === 'postgres' ? answered : sqliteAggregates(context.model.name, columns, answered)
}

/** The columns of `set` among an aggregate's: a grouped one by its name, and its `min_` and `max_`. */
function aggregated(set: NameSet, columns: AggregateColumns): NameSet {
	const names: string[] = []
	const add = (prefix: string, list: readonly string[]) => {
		for (let index = 0; index < list.length; index++) {
			const name = list[index] ?? ''
			if (inSet(set, name)) {
				names[names.length] = `${prefix}${name}`
			}
		}
	}
	add('', columns.groupBy)
	add('min_', columns.min)
	add('max_', columns.max)
	return nameSet(names)
}

/**
 * An aggregate's numbers as Postgres's driver answers them: `count` as bigint text, and an integral `sum` as text too
 * (Postgres sums an integer as bigint or numeric). SQLite answers both as numbers, and a whole sum of a REAL column is
 * text here where Postgres's float8 sum is a number; `AggregateRow` types a sum as either.
 */
function sqliteAggregates<O>(table: string, columns: AggregateColumns, rows: O[]): O[] {
	const integral = (where: string, value: unknown): unknown => {
		if (typeof value !== 'number' || !Number.isInteger(value)) {
			return value
		}
		if (!isSafeInteger(value)) {
			throw new QueryRefusedError('unexpected_row', `${where} came back as an integer past the safe range, which a number cannot hold exactly`)
		}
		return String(value)
	}
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index]
		if (typeof row !== 'object' || row === null) {
			continue
		}
		if (columns.count) {
			defineValue(row, 'count', integral(`${table}.count`, ownDescriptor(row, 'count')?.value))
		}
		for (let position = 0; position < columns.sum.length; position++) {
			const name = `sum_${columns.sum[position] ?? ''}`
			defineValue(row, name, integral(`${table}.${name}`, ownDescriptor(row, name)?.value))
		}
	}
	return rows
}

/** An insert's row, stamped from its capability, the destination it locks, and what it does on a conflict. */
export interface PreparedInsert {
	readonly row: Map<string, Primitive | null>
	readonly destination: RefGrant | undefined
	readonly conflict: OnConflict | undefined
}

/**
 * A dimension table's insert over a capability nobody type-checked: into a container (a new UUIDv7 key, the chain from
 * the container's `Ref`), or for a top-level table the object the `Ref` names.
 */
export function prepareDimensionInsert(context: TableContext, target: unknown, values: unknown, options?: unknown): PreparedInsert {
	const scope = dimensionScope(context.model)
	const grant = refGrant(context, target, listDimension(scope), 'insert')
	const row = readValues(values, context.model.insert, 'insert', context.model)
	const conflict = onConflictOf(context, options, grant.action, row)
	if (scope.container === undefined) {
		// The object does not exist yet; this only refuses a chain the table has no column for.
		linkValues(context.model.name, [{ dimension: scope.dimension, column: scope.key }], grant)
		stampInsert(context, grant, row, scope.key, grant.id)
		return { row, destination: undefined, conflict }
	}
	stampInsert(context, grant, row, scope.key, uuidv7())
	for (const { link, value } of linkValues(context.model.name, context.model.chain, grant)) {
		row.set(link.column, value)
	}
	return { row, destination: grant, conflict }
}

/** An application table's insert, for an `app` capability of its insert action: a new key, no containment. */
export function prepareApplicationInsert(context: TableContext, capability: unknown, values: unknown, options?: unknown): PreparedInsert {
	const grant = appGrant(context, capability, 'insert')
	const row = readValues(values, context.model.insert, 'insert', context.model)
	const conflict = onConflictOf(context, options, grant.action, row)
	stampInsert(context, grant, row, keyOf(context.model), uuidv7())
	return { row, destination: undefined, conflict }
}

/** A child table's insert under the parent its `Ref` names, whose chain is checked against the database. */
export function prepareChildInsert(context: TableContext, parent: unknown, values: unknown, options?: unknown): PreparedInsert {
	const scope = childScope(context)
	const grant = refGrant(context, parent, scope.parent.dimension, 'insert')
	const row = readValues(values, context.model.insert, 'insert', context.model)
	const conflict = onConflictOf(context, options, grant.action, row)
	stampInsert(context, grant, row, scope.key, uuidv7())
	for (const { link, value } of linkValues(context.model.name, context.model.chain, grant)) {
		row.set(link.column, value)
	}
	return { row, destination: grant, conflict }
}

/** A prepared insert, with its conflict handling when the caller named one. */
export function insertPrepared(context: TableContext, run: Runner, prepared: PreparedInsert): Promise<Readonly<Record<string, unknown>>> {
	const conflict = prepared.conflict
	if (conflict === undefined) {
		return insertRow(context, run, prepared.row, prepared.destination)
	}
	return run.write(async (transaction) => {
		if (prepared.destination !== undefined) {
			await lockDestination(transaction, context, prepared.destination)
		}
		return insertOnConflict(context, run, transaction, prepared.row, conflict)
	})
}

/** `DimensionTable.insert` over a capability nobody type-checked; the table probe of `@fabrika/db/testing` calls it too. */
export function insertIntoDimension<O>(context: TableContext, run: Runner, target: unknown, values: unknown): Promise<O> {
	const prepared = prepareDimensionInsert(context, target, values)
	return insertRow(context, run, prepared.row, prepared.destination)
}

/** An application table's insert, for an `app` capability of its insert action. */
export function insertIntoApplication<O>(context: TableContext, run: Runner, capability: unknown, values: unknown): Promise<O> {
	const prepared = prepareApplicationInsert(context, capability, values)
	return insertRow(context, run, prepared.row, prepared.destination)
}

/** `ChildTable.insert` over a capability nobody type-checked. */
export function insertIntoChild<O>(context: TableContext, run: Runner, parent: unknown, values: unknown): Promise<O> {
	const prepared = prepareChildInsert(context, parent, values)
	return insertRow(context, run, prepared.row, prepared.destination)
}

type ReadAction<P, T> = ActionOf<P, T, 'read'>
type Row<DB, P, T> = PolicyRow<DB, P, T>
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
		return selectRows<S>(context, scope, state, heldAction(context, within))
	}

	async get(ref: Ref<DimensionOf<P, T>, ReadAction<P, T>>): Promise<Row<DB, P, T>> {
		return selectOne(this.#context, storeRunner(this.#context), objectPredicate(this.#context, ref, 'read'))
	}

	/**
	 * Into a container (the key is a new UUIDv7, the chain comes from the container's Ref and is checked against
	 * the database), or for a top-level table the object the `Ref` names. Answers an acknowledgement, not the row.
	 */
	async insert(target: Ref<ListDimensionOf<P, T>, ActionOf<P, T, 'insert'>>, values: InsertValues<DB, P, T>): Promise<Acknowledgement<P, T>> {
		return insertIntoDimension(this.#context, storeRunner(this.#context), target, values)
	}

	async update(
		ref: Ref<DimensionOf<P, T>, ActionOf<P, T, 'update'>>,
		values: UpdateValues<DB, P, T>,
		...options: VersionArguments<P, T>
	): Promise<Acknowledgement<P, T>> {
		const context = this.#context
		const scope = objectPredicate(context, ref, 'update')
		const changes = readValues(values, context.model.update, 'update', context.model)
		return updateRow(context, storeRunner(context), addressed(scope), changes, versionArgument(context, options))
	}

	async remove(ref: Ref<DimensionOf<P, T>, ActionOf<P, T, 'delete'>>): Promise<void> {
		const context = this.#context
		await removeRow(context, storeRunner(context), addressed(objectPredicate(context, ref, 'delete')))
	}

	/**
	 * Moves the object to another container: the delete action at the source, the insert action at the target,
	 * whose chain is checked against the database. Every chain column changes; children that copy them follow
	 * through `ON UPDATE CASCADE` on their composite foreign key. Answers the acknowledgement and the new chain.
	 */
	async move(
		ref: Ref<DimensionOf<P, T>, ActionOf<P, T, 'delete'>>,
		to: Ref<ContainerOf<P, T>, ActionOf<P, T, 'insert'>>,
	): Promise<MoveAcknowledgement<P, T>> {
		const context = this.#context
		const container = dimensionScope(context.model).container
		if (container === undefined) {
			throw new CapabilityError('table_kind', `${context.model.name} has no container to move between`)
		}
		const scope = objectPredicate(context, ref, 'delete')
		const target = refGrant(context, to, container.dimension, 'insert')
		const values = linkValues(context.model.name, context.model.chain, target)
		const changes = new Map<string, Primitive | null>(values.map(({ link, value }) => [link.column, value]))
		const acknowledged = await updateRow<Acknowledgement<P, T>>(context, storeRunner(context), addressed(scope), changes, undefined, target)
		return { ...acknowledged, chain: Object.fromEntries(values.map(({ link, value }) => [link.dimension, value])) }
	}

	async aggregate<const S extends AggregateSpec<Row<DB, P, T>>>(
		within: Within<ListDimensionOf<P, T>, ReadAction<P, T>>,
		spec: S,
	): Promise<AggregateRow<Row<DB, P, T>, S>[]> {
		return aggregateRows(this.#context, storeRunner(this.#context), dimensionListPredicate(this.#context, within, 'read'), this.#context.shape, spec)
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
		return selectRows<S>(context, predicate, state, heldAction(context, scope))
	}

	async get(parent: Ref<ParentDimension<P, T>, ReadAction<P, T>>, key: string): Promise<Row<DB, P, T>> {
		return selectOne(this.#context, storeRunner(this.#context), childObjectPredicate(this.#context, parent, key, 'read'))
	}

	/** Under the parent the Ref names, whose chain is checked against the database. Answers an acknowledgement. */
	async insert(parent: Ref<ParentDimension<P, T>, ActionOf<P, T, 'insert'>>, values: InsertValues<DB, P, T>): Promise<Acknowledgement<P, T>> {
		return insertIntoChild(this.#context, storeRunner(this.#context), parent, values)
	}

	async update(
		parent: Ref<ParentDimension<P, T>, ActionOf<P, T, 'update'>>,
		key: string,
		values: UpdateValues<DB, P, T>,
		...options: VersionArguments<P, T>
	): Promise<Acknowledgement<P, T>> {
		const context = this.#context
		const scope = childObjectPredicate(context, parent, key, 'update')
		const changes = readValues(values, context.model.update, 'update', context.model)
		return updateRow(context, storeRunner(context), addressed(scope), changes, versionArgument(context, options))
	}

	async remove(parent: Ref<ParentDimension<P, T>, ActionOf<P, T, 'delete'>>, key: string): Promise<void> {
		const context = this.#context
		await removeRow(context, storeRunner(context), addressed(childObjectPredicate(context, parent, key, 'delete')))
	}

	async aggregate<const S extends AggregateSpec<Row<DB, P, T>>>(scope: ChildListScope<P, T>, spec: S): Promise<AggregateRow<Row<DB, P, T>, S>[]> {
		return aggregateRows(this.#context, storeRunner(this.#context), childListPredicate(this.#context, scope, 'read'), this.#context.shape, spec)
	}
}
Object.freeze(ChildTable.prototype)

/**
 * The runner of `@fabrika/db/testing`'s probe: a store's own, with a file binding of its own, and `held`, which turns
 * each stored file's id in a file column of `values` into a reference the probe holds. The probe writes the file the
 * isolation fixture seeded as a handler writes a reference it read; an id of no stored file stays an id, and is refused.
 */
function probeRunner(context: TableContext): { readonly run: Runner; readonly held: (values: unknown) => Promise<unknown> } {
	const holder = {}
	const run: Runner = { ...storeRunner(context), files: { holder, request: 'probe', graceMs: 1, scans: () => false } }
	const held = async (values: unknown): Promise<unknown> => {
		const columns = ownKeys(context.model.files)
		if (columns.length === 0 || typeof values !== 'object' || values === null) {
			return values
		}
		const ids = columns.flatMap((column) => {
			const value: unknown = ownDescriptor(values, column)?.value
			return typeof value === 'string' ? [value] : []
		})
		const metadata = ids.length === 0 ? new Map() : await storedFilesMetadata(await run.read(), ids)
		const copy = { ...values }
		for (const column of columns) {
			const value: unknown = ownDescriptor(values, column)?.value
			const meta = typeof value === 'string' ? metadata.get(value) : undefined
			if (meta !== undefined) {
				defineValue(copy, column, fileReference(meta, holder, true))
			}
		}
		return copy
	}
	return { run, held }
}

/**
 * One table's operations without the store types, for `@fabrika/db/testing` only: the generated isolation tests address
 * a table by name. Every runtime check of a store applies; a child row is addressed by its parent's capability and
 * `key`, a dimension row by its capability alone.
 */
export interface TableProbe {
	readonly mode: 'dimension' | 'child' | 'app'
	get(capability: unknown, key?: string): Promise<Readonly<Record<string, unknown>>>
	select(capability: unknown): Promise<readonly Readonly<Record<string, unknown>>[]>
	/** `aggregate(capability, { count: true })`; zero rows when the capability reaches none. */
	count(capability: unknown): Promise<string>
	/** `aggregate(capability, { groupBy: columns, count: true })`: the values of `columns` in each group, and its count. */
	group(capability: unknown, columns: readonly string[]): Promise<readonly Readonly<Record<string, unknown>>[]>
	insert(capability: unknown, values: unknown): Promise<unknown>
	update(capability: unknown, key: string | undefined, values: unknown, expectVersion?: number): Promise<unknown>
	remove(capability: unknown, key?: string): Promise<void>
}

function probeOf(context: TableContext): TableProbe {
	const child = context.model.scope.mode === 'child'
	const object = (capability: unknown, key: string | undefined, operation: Operation): OperationNode => {
		if (child) {
			return childObjectPredicate(context, capability, key, operation)
		}
		if (key !== undefined) {
			throw new QueryRefusedError('row_address', `a ${context.model.name} row is addressed by its Ref alone`)
		}
		return objectPredicate(context, capability, operation)
	}
	// An `app` capability reads every row through ctx.db.app: its rows with appRead, its counts with appCount too.
	const list = (capability: unknown, reach: AppReach): OperationNode | undefined => {
		if (runtimeOf(context.connection).capabilities.resolve(capability).kind === 'app') {
			return appRecordPredicate(context, capability, reach)
		}
		return child ? childListPredicate(context, capability, 'read') : dimensionListPredicate(context, capability, 'read')
	}
	// A capability reads the columns of its own action, as ctx.db does.
	const visible = (capability: unknown): readonly string[] => visibleFor(context.model, heldAction(context, capability))
	const { run, held } = probeRunner(context)
	return freeze({
		mode: child ? 'child' : 'dimension',
		get: async (capability: unknown, key?: string) => selectOne<Readonly<Record<string, unknown>>>(context, run, object(capability, key, 'read')),
		select: async (capability: unknown) => {
			const start = startSelect<Readonly<Record<string, unknown>>, NoColumns>(context.shape)
			return selectRows<Readonly<Record<string, unknown>>>(
				context,
				list(capability, 'rows'),
				finishSelect(start, start),
				heldAction(context, capability),
				visible(capability),
			)
		},
		group: async (capability: unknown, columns: readonly string[]) =>
			aggregateRows<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>>(
				context,
				run,
				list(capability, 'rows'),
				actionShape(context.model, visible(capability)),
				{ groupBy: columns, count: true },
			),
		count: async (capability: unknown) => {
			const [row] = await aggregateRows<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>>(
				context,
				run,
				list(capability, 'counts'),
				context.shape,
				{ count: true },
			)
			const count = row === undefined ? '0' : ownEntry(row, 'count')
			return typeof count === 'string' ? count : '0'
		},
		insert: async (capability: unknown, values: unknown) =>
			child
				? insertIntoChild(context, run, capability, await held(values))
				: insertIntoDimension(context, run, capability, await held(values)),
		update: async (capability: unknown, key: string | undefined, values: unknown, expectVersion?: number) => {
			const scope = object(capability, key, 'update')
			const changes = readValues(await held(values), context.model.update, 'update', context.model)
			return updateRow(context, run, addressed(scope), changes, versionArgument(context, expectVersion === undefined ? [] : [{ expectVersion }]))
		},
		remove: async (capability: unknown, key?: string) => removeRow(context, run, addressed(object(capability, key, 'delete'))),
	})
}

/**
 * The probe of an application table: every operation takes an `app` capability and, but for an insert, a key; a read
 * also takes a scoped site's `Ref` or `Within` of the table's read action.
 */
function appProbeOf(context: TableContext): TableProbe {
	const { run, held } = probeRunner(context)
	// A scoped site reads an application table too: the probe answers both, as ctx.db.app does.
	const scoped = (capability: unknown): boolean => runtimeOf(context.connection).capabilities.resolve(capability).kind !== 'app'
	const every = (capability: unknown): OperationNode =>
		scoped(capability) ? scopedApplicationRead(context, capability) : appListPredicate(context, capability)
	const count = async (capability: unknown): Promise<string> => {
		const [row] = await aggregateRows<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>>(
			context,
			run,
			every(capability),
			context.shape,
			{ count: true },
		)
		const value = row === undefined ? '0' : ownEntry(row, 'count')
		return typeof value === 'string' ? value : '0'
	}
	return freeze({
		mode: 'app',
		get: async (capability: unknown, key?: string) => {
			if (scoped(capability)) {
				scopedApplicationRead(context, capability)
				return selectOne<Readonly<Record<string, unknown>>>(context, run, appKeyPredicate(context.model, key))
			}
			return selectOne<Readonly<Record<string, unknown>>>(context, run, appRowPredicate(context, capability, key, 'read'))
		},
		select: async (capability: unknown) => {
			const start = startSelect<Readonly<Record<string, unknown>>, NoColumns>(context.shape)
			return selectRows<Readonly<Record<string, unknown>>>(
				context,
				every(capability),
				finishSelect(start, start),
				heldAction(context, capability),
			)
		},
		count,
		group: async (capability: unknown, columns: readonly string[]) =>
			aggregateRows<Readonly<Record<string, unknown>>, Readonly<Record<string, unknown>>>(context, run, every(capability), context.shape, {
				groupBy: columns,
				count: true,
			}),
		insert: async (capability: unknown, values: unknown) => insertIntoApplication(context, run, capability, await held(values)),
		update: async (capability: unknown, key: string | undefined, values: unknown, expectVersion?: number) => {
			const scope = appRowPredicate(context, capability, key, 'update')
			const changes = readValues(await held(values), context.model.update, 'update', context.model)
			return updateRow(context, run, addressed(scope), changes, versionArgument(context, expectVersion === undefined ? [] : [{ expectVersion }]))
		},
		remove: async (capability: unknown, key?: string) => removeRow(context, run, addressed(appRowPredicate(context, capability, key, 'delete'))),
	})
}

function destinationOf(models: TableModels, model: TableModel, parent: TableModel | undefined): TableModel | undefined {
	if (model.scope.mode === 'child') {
		return parent
	}
	const container = model.scope.mode === 'dimension' ? model.scope.container : undefined
	if (container === undefined) {
		return undefined
	}
	const names = ownKeys(models)
	for (let index = 0; index < names.length; index++) {
		const candidate = modelOf(models, names[index] ?? '')
		if (candidate?.scope.mode === 'dimension' && candidate.scope.dimension === container.dimension) {
			return candidate
		}
	}
	return undefined
}

/** What a select or an aggregate of a capability that reads `visible` may name: those columns, and no join. */
export function actionShape(model: TableModel, visible: readonly string[]): TableShape {
	return freeze({ table: model.name, visible: nameSet(visible), joinable: freeze({}), dates: model.dates })
}

function shapeOf(model: TableModel, joinable: Readonly<Record<string, JoinShape>>): TableShape {
	return freeze({ table: model.name, visible: nameSet(model.visible), joinable, dates: model.dates })
}

function joinShapes(models: TableModels, parent: TableModel): Readonly<Record<string, JoinShape>> {
	const joinable: Record<string, JoinShape> = {}
	if (parent.scope.mode !== 'dimension') {
		return freeze(joinable)
	}
	const names = ownKeys(models)
	for (let index = 0; index < names.length; index++) {
		const model = modelOf(models, names[index] ?? '')
		if (model?.scope.mode === 'child' && model.scope.parent === parent.name) {
			const on: ForeignKeyPair[] = [{ childColumn: model.scope.column, parentColumn: parent.scope.key }]
			for (let position = 0; position < model.scope.inherit.length; position++) {
				const name = model.scope.inherit[position] ?? ''
				on[on.length] = { childColumn: name, parentColumn: name }
			}
			setOwn(joinable, model.name, freeze({ shape: shapeOf(model, freeze({})), readActions: model.actions.read, on: freeze(on) }))
		}
	}
	return freeze(joinable)
}

/** What `serve(contract, { database })` takes: the policies as data. `boot` binds only an object `scoped` created. */
export interface DataLayer {
	/** Every table's policy as data, for the contract compiler. */
	readonly tables: TablePolicies
}

declare const layerTypes: unique symbol

/**
 * What `scoped` returns: the policies, typed by the tables they came from. It has no connection, no locator and no
 * handle of its own; `boot` binds it through `@fabrika/db/framework`, which only `@fabrika/app` imports, and a
 * handler reaches data through `ctx.db`. The brand is type-only: no value has the property.
 */
export interface ScopedDatabase<DB, P> extends DataLayer {
	readonly [layerTypes]?: { readonly db: DB; readonly policies: P }
}

/**
 * Binds the table policies to the data layer. An application calls it once, in `src/app.ts`, and passes the result to
 * `serve(contract, { database })`. Nothing reaches the database until `boot` binds that one object; another `scoped`
 * result never gets a connection.
 */
export function scoped<DB, P>(tables: Tables<DB, P>): ScopedDatabase<DB, P> {
	const models = tableModels(tables)
	const connection: Connection = { runtime: undefined }

	function contextFor(table: string, mode: 'dimension' | 'child' | 'app'): TableContext {
		const model = typeof table === 'string' ? modelOf(models, table) : undefined
		if (model === undefined || model.scope.mode !== mode) {
			throw new QueryRefusedError('unknown_table', `${String(table)} is not a ${mode} table`)
		}
		return contextOf(model)
	}

	function contextOf(model: TableModel): TableContext {
		const parent = model.scope.mode === 'child' ? modelOf(models, model.scope.parent) : undefined
		const joinable = joinShapes(models, model)
		const joins: Record<string, readonly ForeignKeyPair[]> = {}
		const children = ownKeys(joinable)
		for (let index = 0; index < children.length; index++) {
			const child = children[index] ?? ''
			const join = ownEntry(joinable, child)
			if (join !== undefined) {
				setOwn(joins, child, join.on)
			}
		}
		const childModels: Record<string, TableModel> = {}
		for (let index = 0; index < children.length; index++) {
			const child = modelOf(models, children[index] ?? '')
			if (child !== undefined) {
				setOwn(childModels, child.name, child)
			}
		}
		const shape = shapeOf(model, joinable)
		return freeze({
			model,
			parent,
			destination: destinationOf(models, model, parent),
			shape,
			joins: freeze(joins),
			children: freeze(childModels),
			connection,
		})
	}

	const database: ScopedDatabase<DB, P> = Object.freeze({ tables: tablePolicies(tables) })
	register(database, {
		tableContext: contextFor,
		probe(table: string): TableProbe {
			const mode = modelOf(models, table)?.scope.mode
			if (mode === 'app') {
				return appProbeOf(contextFor(table, mode))
			}
			if (mode !== 'dimension' && mode !== 'child') {
				throw new QueryRefusedError('unknown_table', `${String(table)} is not a dimension, child or application table; no store reaches it`)
			}
			return probeOf(contextFor(table, mode))
		},
		bind(runtime: DataLayerRuntime): Locator {
			if (connection.runtime !== undefined) {
				throw new CapabilityError('layer_unbound', 'the data layer is already connected; only the framework connects it, once, at boot')
			}
			const bound: DataLayerRuntime = freeze({ database: runtime.database, capabilities: runtime.capabilities, readOnly: runtime.readOnly })
			connection.runtime = bound
			return async (dimension, id, using) => locateObject(models, bound, dimension, id, using)
		},
		framework: freeze({
			webhooks: webhookTables(() => runtimeOf(connection)),
			jobs: jobLeases(() => runtimeOf(connection)),
			admissions: admissions(() => runtimeOf(connection)),
			files: storedFiles(() => runtimeOf(connection)),
		}),
		data: dataAccess({
			models,
			contextOf(table: string): TableContext {
				const model = modelOf(models, table)
				if (model === undefined) {
					throw new QueryRefusedError('unknown_table', `${String(table)} is not a table of src/db/tables.ts`)
				}
				return contextOf(model)
			},
			runtime: () => runtimeOf(connection),
			newSession: (runtime) => sessionOf(runtime),
			newInvocation: (runtime, readOnly) => new InvocationTransaction(runtime.database, readOnly || runtime.readOnly?.() === true),
			fenced: (runtime, work) => fencedWork(runtime, work),
		}),
	})
	return database
}

/** The context of `table` in the layer `scoped` created, for the framework's own store builders below. */
function storeContext(database: DataLayer, table: string, mode: 'dimension' | 'child'): TableContext {
	const side = frameworkSideOf(database)
	if (side === undefined) {
		throw new TypeError('not a data layer scoped(tables) created')
	}
	return side.tableContext(table, mode)
}

/**
 * A store over one dimension table of the layer: the framework's own tests and kits build them, never an application,
 * whose handlers reach data through `ctx.db`. Exported from `@fabrika/db/testing` only.
 */
export function defineStore<DB, P, const T extends DimensionTableName<P>, S>(
	database: ScopedDatabase<DB, P>,
	table: T,
	build: (t: DimensionTable<DB, P, T>) => S,
): S {
	return build(new DimensionTable(storeContext(database, table, 'dimension')))
}

/** A store over one child table of the layer, as `defineStore`; exported from `@fabrika/db/testing` only. */
export function defineChildStore<DB, P, const T extends ChildTableName<P>, S>(
	database: ScopedDatabase<DB, P>,
	table: T,
	build: (t: ChildTable<DB, P, T>) => S,
): S {
	return build(new ChildTable(storeContext(database, table, 'child')))
}

/** The table that owns `dimension`: the one dimension table scoped by it (`defineTables` refuses a second). */
export function ownerOf(models: TableModels, dimension: string): TableModel | undefined {
	const names = ownKeys(models)
	for (let index = 0; index < names.length; index++) {
		const model = modelOf(models, names[index] ?? '')
		if (model?.scope.mode === 'dimension' && model.scope.dimension === dimension) {
			return model
		}
	}
	return undefined
}

/** The table that owns `dimension`, which the locator reads; a dimension no table owns is located by nothing. */
function locatedOwner(models: TableModels, dimension: unknown): TableModel {
	const owner = typeof dimension === 'string' ? ownerOf(models, dimension) : undefined
	if (owner === undefined) {
		throw new QueryRefusedError('unknown_table', `no table owns the dimension ${String(dimension)}, so nothing locates it`)
	}
	return owner
}

/** One guarded select by key of the containment columns the policy declares; the generated locator of the dimension. */
async function locateObject(
	models: TableModels,
	runtime: DataLayerRuntime,
	dimension: string,
	id: string,
	using: Session | undefined,
): Promise<ReadonlyMap<string, string> | null> {
	const owner = locatedOwner(models, dimension)
	if (typeof id !== 'string' || id.length === 0) {
		throw new QueryRefusedError('row_address', `a ${dimension} is located by its ${keyOf(owner)}, a non-empty string`)
	}
	const key = keyOf(owner)
	const scope = equals(owner.name, key, id)
	const columns: string[] = [key]
	for (let index = 0; index < owner.chain.length; index++) {
		columns[columns.length] = owner.chain[index]?.column ?? ''
	}
	const context: GuardContext = { root: 'SelectQueryNode', table: owner.name, joins: {}, scope }
	const [row] = await (using ?? sessionOf(runtime)).run<Readonly<Record<string, unknown>>>(locateNode(owner.name, columns, scope), context)
	if (row === undefined) {
		return null
	}
	const chain = new Map<string, string>()
	for (let index = 0; index < owner.chain.length; index++) {
		const link = owner.chain[index]
		const value = link === undefined ? undefined : ownEntry(row, link.column)
		if (link === undefined || typeof value !== 'string') {
			throw new PolicyError(`${owner.name}.${link?.column ?? ''} came back as ${typeof value}; a containment column holds its scope value as text`)
		}
		chain.set(link.dimension, value)
	}
	return chain
}
