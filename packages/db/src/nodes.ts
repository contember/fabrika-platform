import {
	AggregateFunctionNode,
	AliasNode,
	AndNode,
	BinaryOperationNode,
	CastNode,
	ColumnNode,
	ColumnUpdateNode,
	DataTypeNode,
	type DeleteQueryNode,
	FromNode,
	GroupByItemNode,
	GroupByNode,
	IdentifierNode,
	type InsertQueryNode,
	JoinNode,
	LimitNode,
	OffsetNode,
	type OnConflictNode,
	type OperationNode,
	OperatorNode,
	OrderByItemNode,
	OrderByNode,
	OrNode,
	ParensNode,
	RawNode,
	ReferenceNode,
	ReturningNode,
	SelectAllNode,
	SelectionNode,
	SelectModifierNode,
	type SelectQueryNode,
	TableNode,
	type UpdateQueryNode,
	ValueListNode,
	ValueNode,
	ValuesNode,
	WhereNode,
} from 'kysely'
import { inSet, type NameSet, nameSet, namesOf } from './builtins'
import type { SqlDialect } from './database'
import type { Compare, Condition, Contains, JoinState, Primitive, SelectState } from './description'
import { QueryRefusedError } from './errors'

export function column(table: string, name: string): ReferenceNode {
	return ReferenceNode.create(ColumnNode.create(name), TableNode.create(table))
}

export function equals(table: string, name: string, value: Primitive): OperationNode {
	return BinaryOperationNode.create(column(table, name), OperatorNode.create('='), ValueNode.create(value))
}

// The scope predicates are built through these, so they read their nodes by index, never through an iterator or a method.
export function allOf(nodes: readonly OperationNode[]): OperationNode {
	let joined = nodes[0]
	if (joined === undefined) {
		throw new QueryRefusedError('statement_shape', 'an empty conjunction')
	}
	for (let index = 1; index < nodes.length; index++) {
		const node = nodes[index]
		if (node !== undefined) {
			joined = AndNode.create(joined, node)
		}
	}
	return joined
}

/** One node, or the OR of several in a parenthesis: inside an AND, `a and b or c` would read as `(a and b) or c`. */
export function anyOf(nodes: readonly OperationNode[]): OperationNode {
	let joined = nodes[0]
	if (joined === undefined) {
		throw new QueryRefusedError('statement_shape', 'an empty disjunction')
	}
	for (let index = 1; index < nodes.length; index++) {
		const node = nodes[index]
		if (node !== undefined) {
			joined = OrNode.create(joined, node)
		}
	}
	return nodes.length === 1 ? joined : ParensNode.create(joined)
}

export function inList(table: string, name: string, values: readonly string[]): OperationNode {
	return BinaryOperationNode.create(
		column(table, name),
		OperatorNode.create('in'),
		ValueListNode.create(valueNodes(values)),
	)
}

function valueNodes(values: readonly string[]): ValueNode[] {
	const nodes: ValueNode[] = []
	for (let index = 0; index < values.length; index++) {
		const value = values[index]
		if (value !== undefined) {
			nodes[nodes.length] = ValueNode.create(value)
		}
	}
	return nodes
}

/** The scope of a `Within` that is not limited to scope values. */
export function everything(): OperationNode {
	return ValueNode.createImmediate(true)
}

function compareNode(table: string, condition: Compare): OperationNode {
	const value = condition.value
	const right = value === null
		? ValueNode.createImmediate(null)
		: Array.isArray(value)
		? ValueListNode.create(value.map((item) => ValueNode.create(item)))
		: ValueNode.create(value)
	return BinaryOperationNode.create(column(table, condition.column), OperatorNode.create(condition.operator), right)
}

/** LIKE treats `\` as its escape character by default, so the text matches literally. */
export function containsPattern(text: string): string {
	return `%${text.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
}

function containsNode(table: string, condition: Contains): OperationNode {
	return BinaryOperationNode.create(column(table, condition.column), OperatorNode.create('ilike'), ValueNode.create(containsPattern(condition.text)))
}

function conditionNode(table: string, condition: Condition): OperationNode {
	switch (condition.kind) {
		case 'compare':
			return compareNode(table, condition)
		case 'contains':
			return containsNode(table, condition)
		case 'any': {
			const [first, ...rest] = condition.conditions.map((item) => item.kind === 'compare' ? compareNode(table, item) : containsNode(table, item))
			if (first === undefined) {
				throw new QueryRefusedError('statement_shape', 'whereAny needs at least one condition')
			}
			return ParensNode.create(rest.reduce<OperationNode>((left, right) => OrNode.create(left, right), first))
		}
	}
}

function conditionsNode(table: string, conditions: readonly Condition[]): OperationNode | undefined {
	return conditions.length === 0 ? undefined : allOf(conditions.map((condition) => conditionNode(table, condition)))
}

/**
 * The caller's conditions go inside an explicit parenthesis and the scope is the top-level right conjunct, so
 * `x or true` cannot escape it. The guard checks this shape.
 */
export function scopedWhere(conditions: OperationNode | undefined, scope: OperationNode): WhereNode {
	return WhereNode.create(conditions === undefined ? scope : AndNode.create(ParensNode.create(conditions), scope))
}

function selection(table: string, name: string): SelectionNode {
	return SelectionNode.create(column(table, name))
}

/**
 * A selected column; a `date` one as `cast(<column> as text)` under its own name, so the layer reads the database's
 * day rather than the `Date` `Bun.SQL` decodes, which drifts by the process's offset outside 0001–9999.
 */
function rowSelection(table: string, name: string, days: NameSet): SelectionNode {
	if (!inSet(days, name)) {
		return selection(table, name)
	}
	return SelectionNode.create(AliasNode.create(CastNode.create(column(table, name), DataTypeNode.create('text')), IdentifierNode.create(name)))
}

const NO_DAYS: NameSet = nameSet([])

/** `returning key as id[, version as version]`: a mutation's acknowledgement, never row data. */
export function acknowledgement(table: string, key: string, version: string | undefined): ReturningNode {
	const fields: [string, string][] = version === undefined ? [[key, 'id']] : [[key, 'id'], [version, 'version']]
	return ReturningNode.create(fields.map(([name, alias]) => SelectionNode.create(AliasNode.create(column(table, name), IdentifierNode.create(alias)))))
}

function joinNode(parent: string, join: JoinState): JoinNode {
	const child = join.join.shape.table
	const foreignKey = allOf(
		join.join.on.map((pair) =>
			BinaryOperationNode.create(column(child, pair.childColumn), OperatorNode.create('='), column(parent, pair.parentColumn))
		),
	)
	const conditions = conditionsNode(child, join.select.conditions)
	const on = conditions === undefined ? foreignKey : AndNode.create(foreignKey, ParensNode.create(conditions))
	return JoinNode.createWithOn('InnerJoin', TableNode.create(child), on)
}

function joinedSelections(join: JoinState): SelectionNode[] {
	const child = join.join.shape.table
	const columns = join.select.columns ?? namesOf(join.join.shape.visible)
	return columns.map((name) => SelectionNode.create(AliasNode.create(column(child, name), IdentifierNode.create(`${child}.${name}`))))
}

/**
 * One order term. Postgres sorts nulls last ascending and first descending; SQLite the other way, so on SQLite the term
 * states Postgres's order and a keyset page (`orm.ts`) reads the same rows after its cursor on both.
 */
function orderItem(table: string, order: SelectState['orderBy'][number], dialect: SqlDialect): OrderByItemNode {
	const item = OrderByItemNode.create(column(table, order.column), RawNode.createWithSql(order.direction))
	return dialect === 'postgres' ? item : Object.freeze({ ...item, nulls: order.direction === 'asc' ? 'last' : 'first' })
}

/** `after` is a keyset page's position, ANDed to the caller's conditions inside their parenthesis. */
export function selectNode(
	state: SelectState,
	visible: readonly string[],
	scope: OperationNode,
	after?: OperationNode,
	days: NameSet = NO_DAYS,
	dialect: SqlDialect = 'postgres',
): SelectQueryNode {
	const table = state.table
	const columns = state.columns ?? visible
	const conditions = conditionsNode(table, state.conditions)
	const filter = after === undefined ? conditions : conditions === undefined ? after : AndNode.create(conditions, ParensNode.create(after))
	const orderBy = state.orderBy.map((order) => orderItem(table, order, dialect))
	const node: SelectQueryNode = {
		kind: 'SelectQueryNode',
		from: FromNode.create([TableNode.create(table)]),
		selections: [...columns.map((name) => rowSelection(table, name, days)), ...state.joins.flatMap(joinedSelections)],
		joins: state.joins.length === 0 ? undefined : state.joins.map((join) => joinNode(table, join)),
		where: scopedWhere(filter, scope),
		orderBy: orderBy.length === 0 ? undefined : OrderByNode.create(orderBy),
		limit: state.limit === undefined ? undefined : LimitNode.create(ValueNode.create(state.limit)),
		offset: state.offset === undefined ? undefined : OffsetNode.create(ValueNode.create(state.offset)),
	}
	return Object.freeze(node)
}

export interface AggregateColumns {
	readonly groupBy: readonly string[]
	readonly count: boolean
	readonly sum: readonly string[]
	readonly min: readonly string[]
	readonly max: readonly string[]
}

function aggregate(func: string, aggregated: OperationNode, alias: string): SelectionNode {
	return SelectionNode.create(AliasNode.create(AggregateFunctionNode.create(func, [aggregated]), IdentifierNode.create(alias)))
}

export function aggregateNode(
	table: string,
	columns: AggregateColumns,
	conditions: readonly Condition[],
	scope: OperationNode,
	days: NameSet = NO_DAYS,
): SelectQueryNode {
	const selections = [
		...columns.groupBy.map((name) => rowSelection(table, name, days)),
		...(columns.count ? [aggregate('count', SelectAllNode.create(), 'count')] : []),
		...columns.sum.map((name) => aggregate('sum', column(table, name), `sum_${name}`)),
		...columns.min.map((name) => aggregate('min', column(table, name), `min_${name}`)),
		...columns.max.map((name) => aggregate('max', column(table, name), `max_${name}`)),
	]
	const node: SelectQueryNode = {
		kind: 'SelectQueryNode',
		from: FromNode.create([TableNode.create(table)]),
		selections,
		where: scopedWhere(conditionsNode(table, conditions), scope),
		groupBy: columns.groupBy.length === 0 ? undefined : GroupByNode.create(columns.groupBy.map((name) => GroupByItemNode.create(column(table, name)))),
	}
	return Object.freeze(node)
}

/** `conflict` names the columns of a unique index the insert does nothing on: `on conflict (<columns>) do nothing`. */
export function insertNode(
	table: string,
	values: ReadonlyMap<string, Primitive | null>,
	answer: ReturningNode,
	conflict?: readonly string[],
): InsertQueryNode {
	const names = [...values.keys()]
	const onConflict: OnConflictNode | undefined = conflict === undefined
		? undefined
		: Object.freeze({ kind: 'OnConflictNode', columns: conflict.map((name) => ColumnNode.create(name)), doNothing: true })
	const node: InsertQueryNode = {
		kind: 'InsertQueryNode',
		into: TableNode.create(table),
		columns: names.map((name) => ColumnNode.create(name)),
		values: ValuesNode.create([ValueListNode.create(names.map((name) => ValueNode.create(values.get(name) ?? null)))]),
		...(onConflict === undefined ? {} : { onConflict }),
		returning: answer,
	}
	return Object.freeze(node)
}

export function updateNode(
	table: string,
	values: ReadonlyMap<string, Primitive | null>,
	bump: string | undefined,
	where: WhereNode,
	answer: ReturningNode,
): UpdateQueryNode {
	const updates = [...values].map(([name, value]) => ColumnUpdateNode.create(ColumnNode.create(name), ValueNode.create(value)))
	if (bump !== undefined) {
		const next = BinaryOperationNode.create(column(table, bump), OperatorNode.create('+'), ValueNode.create(1))
		updates.push(ColumnUpdateNode.create(ColumnNode.create(bump), next))
	}
	if (updates.length === 0) {
		throw new QueryRefusedError('statement_shape', 'nothing to update')
	}
	const node: UpdateQueryNode = { kind: 'UpdateQueryNode', table: TableNode.create(table), updates, where, returning: answer }
	return Object.freeze(node)
}

export function deleteNode(table: string, where: WhereNode, key: string): DeleteQueryNode {
	const node: DeleteQueryNode = {
		kind: 'DeleteQueryNode',
		from: FromNode.create([TableNode.create(table)]),
		where,
		returning: acknowledgement(table, key, undefined),
	}
	return Object.freeze(node)
}

/** `select key from table where (conditions) and scope limit 1`: does the scoped object exist? */
export function existsNode(table: string, key: string, scope: OperationNode, conditions?: OperationNode): SelectQueryNode {
	const node: SelectQueryNode = {
		kind: 'SelectQueryNode',
		from: FromNode.create([TableNode.create(table)]),
		selections: [selection(table, key)],
		where: scopedWhere(conditions, scope),
		limit: LimitNode.create(ValueNode.create(1)),
	}
	return Object.freeze(node)
}

/** `select key as id, version as version from table where (conditions) and scope limit 1`: an update that sets nothing. */
export function acknowledgementNode(table: string, key: string, version: string | undefined, where: WhereNode): SelectQueryNode {
	const node: SelectQueryNode = {
		kind: 'SelectQueryNode',
		from: FromNode.create([TableNode.create(table)]),
		selections: acknowledgement(table, key, version).selections,
		where,
		limit: LimitNode.create(ValueNode.create(1)),
	}
	return Object.freeze(node)
}

/** `select columns from table where scope limit 1`: the containment columns of one object, for the framework's locator. */
export function locateNode(table: string, columns: readonly string[], scope: OperationNode): SelectQueryNode {
	const node: SelectQueryNode = {
		kind: 'SelectQueryNode',
		from: FromNode.create([TableNode.create(table)]),
		selections: columns.map((name) => selection(table, name)),
		where: scopedWhere(undefined, scope),
		limit: LimitNode.create(ValueNode.create(1)),
	}
	return Object.freeze(node)
}

/**
 * The same check, locked: `for share` keeps the row from moving until the transaction that checked it ends, `for
 * update` also keeps every other writer and locker of it waiting.
 */
export function lockNode(table: string, key: string, scope: OperationNode, lock: 'share' | 'update' = 'share'): SelectQueryNode {
	return Object.freeze({ ...existsNode(table, key, scope), endModifiers: [lockModifier(lock)] })
}

function lockModifier(lock: 'share' | 'update'): SelectModifierNode {
	return SelectModifierNode.create(lock === 'share' ? 'ForShare' : 'ForUpdate')
}

/** The alias a keyset page's position column is selected under; a column name holds no dot, so none collides. */
export function cursorAlias(index: number): string {
	return `keyset.c${index}`
}

/** `select …, cast(<column> as text) as "keyset.c<n>"`: each order column's exact value, which a Date would round. */
export function withCursorColumns(node: SelectQueryNode, table: string, columns: readonly string[]): SelectQueryNode {
	const cursor = columns.map((name, index) =>
		SelectionNode.create(AliasNode.create(CastNode.create(column(table, name), DataTypeNode.create('text')), IdentifierNode.create(cursorAlias(index))))
	)
	return Object.freeze({ ...node, selections: [...(node.selections ?? []), ...cursor] })
}

/**
 * A queue claim's lease: `select <columns> from table where (<conditions> and (<due> is not null and <due> <= $now and
 * <attempts> < $max)) and scope order by <due>, <key> limit $n for update skip locked`. A row another claim holds is
 * skipped, never waited for.
 */
export function claimNode(
	state: SelectState,
	columns: readonly string[],
	due: { readonly due: string; readonly attempts: string; readonly now: Date; readonly maxAttempts: number },
	scope: OperationNode,
	days: NameSet,
	dialect: SqlDialect = 'postgres',
): SelectQueryNode {
	const table = state.table
	const waiting = allOf([
		BinaryOperationNode.create(column(table, due.due), OperatorNode.create('is not'), ValueNode.createImmediate(null)),
		BinaryOperationNode.create(column(table, due.due), OperatorNode.create('<='), ValueNode.create(due.now)),
		BinaryOperationNode.create(column(table, due.attempts), OperatorNode.create('<'), ValueNode.create(due.maxAttempts)),
	])
	const node = selectNode(state, columns, scope, waiting, days, dialect)
	return Object.freeze({ ...node, endModifiers: [SelectModifierNode.create('ForUpdate'), SelectModifierNode.create('SkipLocked')] })
}

/**
 * When the same claim next finds a row: `select <due> from table where (<conditions> and (<due> > $now and <attempts> <
 * $max)) and scope order by <due> limit 1`, with `state` the claim's conditions ordered by `<due>`, limited to one.
 */
export function nextClaimNode(
	state: SelectState,
	due: { readonly due: string; readonly attempts: string; readonly now: Date; readonly maxAttempts: number },
	scope: OperationNode,
	days: NameSet,
	dialect: SqlDialect = 'postgres',
): SelectQueryNode {
	const table = state.table
	const later = allOf([
		BinaryOperationNode.create(column(table, due.due), OperatorNode.create('>'), ValueNode.create(due.now)),
		BinaryOperationNode.create(column(table, due.attempts), OperatorNode.create('<'), ValueNode.create(due.maxAttempts)),
	])
	return selectNode(state, [due.due], scope, later, days, dialect)
}

/** `select <columns> from table where scope for update`: a mutation's precondition read of its own target. */
export function lockedSelectNode(table: string, columns: readonly string[], scope: OperationNode, days: NameSet = NO_DAYS): SelectQueryNode {
	const node: SelectQueryNode = {
		kind: 'SelectQueryNode',
		from: FromNode.create([TableNode.create(table)]),
		selections: columns.map((name) => rowSelection(table, name, days)),
		where: scopedWhere(undefined, scope),
		endModifiers: [lockModifier('update')],
	}
	return Object.freeze(node)
}
