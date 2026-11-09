import type { OperationNode } from 'kysely'
import { freeze, hasOwn, inSet, isArray, type NameSet, nameSet, ownDescriptor, ownKeys } from './builtins'
import { QueryRefusedError } from './errors'
import { isPlainAlias, isPlainIdentifier } from './identifier'

// The walk below uses index loops and the captured built-ins only, never an iterator or a prototype method.

export type RootKind = 'SelectQueryNode' | 'InsertQueryNode' | 'UpdateQueryNode' | 'DeleteQueryNode'

export interface ForeignKeyPair {
	readonly childColumn: string
	readonly parentColumn: string
}

export interface GuardContext {
	readonly root: RootKind
	readonly table: string
	/** The children a select may join, each with the composite foreign key its ON must equal. */
	readonly joins: Readonly<Record<string, readonly ForeignKeyPair[]>>
	/** The scope predicate; it must be the WHERE itself or its top-level right conjunct. Absent for an insert only. */
	readonly scope: OperationNode | undefined
	/**
	 * A select that locks its rows: `share` is the layer's check of a mutation's destination, `update` a mutation's
	 * `getForUpdate` of its own target, `claim` a queue claim's `for update skip locked`. No other lock is admitted.
	 */
	readonly lock?: 'share' | 'update' | 'claim'
	/** An insert that does nothing on a conflict of its listed columns: `on conflict (columns) do nothing`, and no other. */
	readonly onConflict?: 'nothing'
	/**
	 * The tables a scope predicate's subqueries may read, each with the columns one may select: a relation's source by
	 * its node column, a condition path's target by its key. Without it, a scope holds no subquery.
	 */
	readonly subqueries?: Readonly<Record<string, readonly string[]>>
}

/** A subquery of the scope predicate the shape check admitted, and the one table it reads. */
interface Admitted {
	readonly node: unknown
	readonly table: string
}

/**
 * How deep subqueries of a scope nest, the deepest the layer builds: a reveal's row (1) under a condition path of three
 * hops, and a reveal matched through a secondary path above the relation's dimension (the reveal's row, the path's
 * table, the source, and the table a principal path reads).
 */
const MAX_SCOPE_NESTING = 4

function lookup(...names: string[]): NameSet {
	return nameSet(names)
}

/** The properties each root node may carry; anything else (with, explain, modifiers, on conflict, …) is refused. */
const ROOT_PROPERTIES: Readonly<Record<RootKind, NameSet>> = freeze({
	SelectQueryNode: lookup('kind', 'from', 'selections', 'joins', 'where', 'groupBy', 'orderBy', 'limit', 'offset'),
	InsertQueryNode: lookup('kind', 'into', 'columns', 'values', 'returning'),
	UpdateQueryNode: lookup('kind', 'table', 'updates', 'where', 'returning'),
	DeleteQueryNode: lookup('kind', 'from', 'where', 'returning'),
})

const ROOT_KINDS = lookup('SelectQueryNode', 'InsertQueryNode', 'UpdateQueryNode', 'DeleteQueryNode')

const NODE_KINDS = lookup(
	'FromNode',
	'TableNode',
	'SchemableIdentifierNode',
	'IdentifierNode',
	'SelectionNode',
	'SelectAllNode',
	'ReferenceNode',
	'ColumnNode',
	'AliasNode',
	'WhereNode',
	'AndNode',
	'OrNode',
	'ParensNode',
	'BinaryOperationNode',
	'OperatorNode',
	'ValueNode',
	'ValueListNode',
	'OrderByNode',
	'OrderByItemNode',
	'LimitNode',
	'OffsetNode',
	'JoinNode',
	'OnNode',
	'GroupByNode',
	'GroupByItemNode',
	'AggregateFunctionNode',
	'ValuesNode',
	'ColumnUpdateNode',
	'ReturningNode',
	// Only as an orderBy direction; checked below.
	'RawNode',
	// Only as the one lock of a destination check or a getForUpdate, or a claim's two; checked below.
	'SelectModifierNode',
	// Only as an insert's `on conflict (columns) do nothing`; checked below.
	'OnConflictNode',
	// Only as a selected own column's text, the exact position a keyset page continues from; checked below.
	'CastNode',
	'DataTypeNode',
	// Only as `not` of a scope predicate's branch, which the shape check admitted.
	'UnaryOperationNode',
)

const COMPARISON_OPERATORS = lookup('=', '<>', '<', '<=', '>', '>=', 'like', 'ilike', 'not like', 'not ilike', 'in', 'not in', 'is', 'is not')
const AGGREGATES = lookup('count', 'sum', 'min', 'max')

/** The path from the root to a node, as a linked list (no array spread, which an iterator patch could subvert). */
interface Visit {
	readonly node: OperationNode
	readonly key: string
	readonly up: Visit | undefined
}

/** Refuses any operation tree outside the allowlist. Runs on the final tree, immediately before it is compiled. */
export function assertAllowedTree(root: OperationNode, context: GuardContext): void {
	if (root.kind !== context.root) {
		throw new QueryRefusedError('statement_shape', `expected a ${context.root}, got ${String(root.kind)}`)
	}
	const allowed = ROOT_PROPERTIES[context.root]
	const keys = ownKeys(root)
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		const lockModifier = key === 'endModifiers' && context.lock !== undefined && context.root === 'SelectQueryNode'
		const conflict = key === 'onConflict' && context.onConflict === 'nothing' && context.root === 'InsertQueryNode'
		if (read(root, key) !== undefined && !inSet(allowed, key) && !lockModifier && !conflict) {
			throw new QueryRefusedError('statement_shape', `${context.root}.${key} is not allowed`)
		}
	}
	const admitted: Admitted[] = []
	checkRoot(root, context, admitted)
	walk(root, undefined, context, admitted, undefined)
}

function checkRoot(root: OperationNode, context: GuardContext, admitted: Admitted[]): void {
	const target = context.root === 'InsertQueryNode'
		? read(root, 'into')
		: context.root === 'UpdateQueryNode'
		? read(root, 'table')
		: soleFrom(read(root, 'from'))
	if (tableName(target) !== context.table) {
		throw new QueryRefusedError('statement_shape', `the statement must address ${context.table} only`)
	}
	const where = read(root, 'where')
	if (context.scope === undefined) {
		if (context.root !== 'InsertQueryNode' || where !== undefined) {
			throw new QueryRefusedError('scope_predicate', 'a statement without its scope predicate is not allowed')
		}
		return
	}
	const predicate = read(where, 'where')
	const scoped = predicate === context.scope
		|| (kindOf(predicate) === 'AndNode' && read(predicate, 'right') === context.scope && kindOf(read(predicate, 'left')) === 'ParensNode')
	if (!scoped) {
		throw new QueryRefusedError('scope_predicate', 'the scope predicate must be the top-level conjunct of WHERE')
	}
	const reach = (node: unknown) => isReach(node, context.table, context.subqueries, admitted)
	const scope = context.scope
	const shaped = reach(scope)
		|| (kindOf(scope) === 'AndNode' && hasOnly(scope, CONNECTIVE_KEYS) && reach(read(scope, 'left'))
			&& kindOf(read(scope, 'right')) === 'ParensNode'
			&& isScopeTree(read(scope, 'right'), context.table, context.subqueries, admitted, 0))
	if (!shaped) {
		throw new QueryRefusedError(
			'scope_predicate',
			'the scope predicate must be true, an AND of column = value, a parenthesized OR of column in (values) or relation rows, or one of these AND a parenthesized condition, over the statement table',
		)
	}
}

/**
 * What a capability reaches before its action's condition narrows it: everything (a global grant), a Ref's chain of
 * equalities, and its relation rows after them, or a Within's memberships of values and relation rows.
 */
function isReach(node: unknown, table: string, subqueries: GuardContext['subqueries'], admitted: Admitted[]): boolean {
	const equality = (leaf: unknown) => isScopeEquality(leaf, table)
	const related = (leaf: unknown) => isRelationMembership(leaf, table, subqueries, admitted)
	const member = (leaf: unknown) => isScopeMembership(leaf, table) || related(leaf)
	return isEverything(node)
		|| isTreeOf(node, 'AndNode', equality)
		|| isUnionOf(node, member)
		|| (kindOf(node) === 'AndNode' && isTreeOf(read(node, 'left'), 'AndNode', equality) && isUnionOf(read(node, 'right'), related))
}

/** One leaf, or a parenthesized OR tree of them. */
function isUnionOf(node: unknown, leaf: (node: unknown) => boolean): boolean {
	return leaf(node) || (kindOf(node) === 'ParensNode' && kindOf(read(node, 'node')) === 'OrNode' && isTreeOf(read(node, 'node'), 'OrNode', leaf))
}

/** `table.<node> in (select S.<node> from S where S.<principal> = $me and …)`: the rows a relation reaches. */
function isRelationMembership(node: unknown, table: string, subqueries: GuardContext['subqueries'], admitted: Admitted[], depth = 0): boolean {
	return kindOf(node) === 'BinaryOperationNode' && hasOnly(node, BINARY_KEYS) && read(read(node, 'operator'), 'operator') === 'in'
		&& isOwnColumn(read(node, 'leftOperand'), table)
		&& isScopeSubquery(read(node, 'rightOperand'), subqueries, admitted, depth + 1, true)
}

/**
 * A scope with relations or conditions: AND, OR, parentheses and `not` over tests of the table's own columns against a
 * bound value, a bound list, null, or a subquery that reads one admitted table, selects one admitted column of it and
 * is scoped the same way over that table. Never `true` inside: that would make a branch vacuous.
 */
function isScopeTree(node: unknown, table: string, subqueries: GuardContext['subqueries'], admitted: Admitted[], depth: number): boolean {
	switch (kindOf(node)) {
		case 'AndNode':
		case 'OrNode':
			return hasOnly(node, CONNECTIVE_KEYS) && isScopeTree(read(node, 'left'), table, subqueries, admitted, depth)
				&& isScopeTree(read(node, 'right'), table, subqueries, admitted, depth)
		case 'ParensNode':
			return hasOnly(node, PARENS_KEYS) && isScopeTree(read(node, 'node'), table, subqueries, admitted, depth)
		case 'UnaryOperationNode':
			return hasOnly(node, UNARY_KEYS) && read(read(node, 'operator'), 'operator') === 'not'
				&& isScopeTree(read(node, 'operand'), table, subqueries, admitted, depth)
		case 'BinaryOperationNode':
			return isScopeTest(node, table, subqueries, admitted, depth)
		default:
			return false
	}
}

function isScopeTest(node: unknown, table: string, subqueries: GuardContext['subqueries'], admitted: Admitted[], depth: number): boolean {
	const operator = read(read(node, 'operator'), 'operator')
	if (!hasOnly(node, BINARY_KEYS) || !isOwnColumn(read(node, 'leftOperand'), table) || !inSet(SCOPE_OPERATORS, operator)) {
		return false
	}
	const right = read(node, 'rightOperand')
	if (operator === 'is' || operator === 'is not') {
		return kindOf(right) === 'ValueNode' && read(right, 'immediate') === true && read(right, 'value') === null
	}
	if (operator === 'in' || operator === 'not in') {
		if (kindOf(right) === 'ValueListNode') {
			return isBoundList(right)
		}
		return operator === 'in' && isScopeSubquery(right, subqueries, admitted, depth + 1, false)
	}
	return isBoundValue(right)
}

function isBoundList(list: unknown): boolean {
	const values = read(list, 'values')
	if (!isArray(values) || values.length === 0) {
		return false
	}
	for (let index = 0; index < values.length; index++) {
		if (!isBoundValue(values[index])) {
			return false
		}
	}
	return true
}

/**
 * `(select S.<column> from S where <scope tree over S>)`, S and its column admitted, nothing else on the node. A relation's
 * subquery is `anchored`: its WHERE starts with an equality to a bound value, the principal, so it never reads every row.
 */
function isScopeSubquery(node: unknown, subqueries: GuardContext['subqueries'], admitted: Admitted[], depth: number, anchored: boolean): boolean {
	if (subqueries === undefined || depth > MAX_SCOPE_NESTING || kindOf(node) !== 'SelectQueryNode' || !hasOnly(node, SUBQUERY_KEYS)) {
		return false
	}
	const from = read(node, 'from')
	const froms = read(from, 'froms')
	if (!hasOnly(from, FROM_KEYS) || !isArray(froms) || froms.length !== 1) {
		return false
	}
	const table = tableName(froms[0])
	if (table === undefined || !hasOwn(subqueries, table)) {
		return false
	}
	const columns = subqueries[table] ?? []
	const selections = read(node, 'selections')
	if (!isArray(selections) || selections.length !== 1 || !hasOnly(selections[0], SELECTION_KEYS)) {
		return false
	}
	const selected = read(selections[0], 'selection')
	const name = read(read(read(selected, 'column'), 'column'), 'name')
	let known = false
	for (let index = 0; index < columns.length; index++) {
		if (columns[index] === name) {
			known = true
		}
	}
	const where = read(node, 'where')
	if (!known || !isOwnColumn(selected, table) || !hasOnly(where, WHERE_KEYS)) {
		return false
	}
	const condition = read(where, 'where')
	if (anchored ? !isAnchored(condition, table, subqueries, admitted, depth) : !isScopeTree(condition, table, subqueries, admitted, depth)) {
		return false
	}
	admitted[admitted.length] = { node, table }
	return true
}

/**
 * `S.<column> = $n`, `S.<column> in ($1, …)` (a secondary path's container: the nodes inside bound containers), or a
 * relation's membership over `S` (a reveal: `R.<key> in (<anchored subquery>)`), then any scope tree AND-ed after it.
 * Each way the innermost subquery starts with a test against bound values, so it never reads every row.
 */
function isAnchored(node: unknown, table: string, subqueries: GuardContext['subqueries'], admitted: Admitted[], depth: number): boolean {
	if (kindOf(node) === 'AndNode') {
		return hasOnly(node, CONNECTIVE_KEYS) && isAnchored(read(node, 'left'), table, subqueries, admitted, depth)
			&& isScopeTree(read(node, 'right'), table, subqueries, admitted, depth)
	}
	return isScopeEquality(node, table) || isScopeMembership(node, table) || isRelationMembership(node, table, subqueries, admitted, depth)
}

/** True when every own property of `node` is one of `keys`: a scope node carries nothing the shape check did not read. */
function hasOnly(node: unknown, keys: NameSet): boolean {
	if (typeof node !== 'object' || node === null) {
		return false
	}
	const own = ownKeys(node)
	for (let index = 0; index < own.length; index++) {
		const key = own[index] ?? ''
		if (!inSet(keys, key) && read(node, key) !== undefined) {
			return false
		}
	}
	return true
}

const CONNECTIVE_KEYS = lookup('kind', 'left', 'right')
const PARENS_KEYS = lookup('kind', 'node')
const UNARY_KEYS = lookup('kind', 'operator', 'operand')
const BINARY_KEYS = lookup('kind', 'leftOperand', 'operator', 'rightOperand')
const SUBQUERY_KEYS = lookup('kind', 'from', 'selections', 'where')
const FROM_KEYS = lookup('kind', 'froms')
const SELECTION_KEYS = lookup('kind', 'selection')
const WHERE_KEYS = lookup('kind', 'where')
const SCOPE_OPERATORS = lookup('=', '<>', '<', '<=', '>', '>=', 'in', 'not in', 'is', 'is not')

/** A Within that is not limited to scope values. */
function isEverything(node: unknown): boolean {
	return kindOf(node) === 'ValueNode' && read(node, 'immediate') === true && read(node, 'value') === true
}

/** Nodes of one connective whose every leaf passes `leaf`; a leaf is never itself a connective. */
function isTreeOf(node: unknown, connective: 'AndNode' | 'OrNode', leaf: (node: unknown) => boolean): boolean {
	if (kindOf(node) === connective) {
		return isTreeOf(read(node, 'left'), connective, leaf) && isTreeOf(read(node, 'right'), connective, leaf)
	}
	return leaf(node)
}

/** `table.column = $n`: one link of a Ref's chain. */
function isScopeEquality(node: unknown, table: string): boolean {
	return kindOf(node) === 'BinaryOperationNode'
		&& read(read(node, 'operator'), 'operator') === '='
		&& isOwnColumn(read(node, 'leftOperand'), table)
		&& isBoundValue(read(node, 'rightOperand'))
}

/** `table.column in ($1, …)`: a Within's own values, or one container's. */
function isScopeMembership(node: unknown, table: string): boolean {
	if (
		kindOf(node) !== 'BinaryOperationNode' || read(read(node, 'operator'), 'operator') !== 'in' || !isOwnColumn(read(node, 'leftOperand'), table)
	) {
		return false
	}
	const list = read(node, 'rightOperand')
	const values = read(list, 'values')
	if (kindOf(list) !== 'ValueListNode' || !isArray(values) || values.length === 0) {
		return false
	}
	for (let index = 0; index < values.length; index++) {
		if (!isBoundValue(values[index])) {
			return false
		}
	}
	return true
}

function isOwnColumn(node: unknown, table: string): boolean {
	return kindOf(node) === 'ReferenceNode' && tableName(read(node, 'table')) === table && kindOf(read(node, 'column')) === 'ColumnNode'
}

function isBoundValue(node: unknown): boolean {
	return kindOf(node) === 'ValueNode' && read(node, 'immediate') !== true
}

function soleFrom(from: unknown): unknown {
	const froms = read(from, 'froms')
	if (!isArray(froms) || froms.length !== 1) {
		throw new QueryRefusedError('statement_shape', 'exactly one table in FROM')
	}
	return froms[0]
}

function walk(
	node: OperationNode,
	parent: Visit | undefined,
	context: GuardContext,
	admitted: readonly Admitted[],
	inside: string | undefined,
): void {
	const subquery = parent === undefined ? undefined : admittedTable(node, admitted)
	const reading = subquery ?? inside
	if (subquery === undefined) {
		checkNode(node, parent, context, reading)
	}
	if (node.kind === 'ValueNode') {
		return
	}
	const keys = ownKeys(node)
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		const value = read(node, key)
		const children: readonly unknown[] = isArray(value) ? value : [value]
		for (let position = 0; position < children.length; position++) {
			const child = children[position]
			if (isOperationNode(child)) {
				walk(child, { node, key, up: parent }, context, admitted, reading)
			} else if (typeof child === 'object' && child !== null) {
				throw new QueryRefusedError('statement_shape', `unexpected structure under ${node.kind}.${key}`)
			}
		}
	}
}

/** The table an admitted subquery reads, when `node` is one, by identity. */
function admittedTable(node: unknown, admitted: readonly Admitted[]): string | undefined {
	for (let index = 0; index < admitted.length; index++) {
		const entry = admitted[index]
		if (entry !== undefined && entry.node === node) {
			return entry.table
		}
	}
	return undefined
}

function checkNode(node: OperationNode, parent: Visit | undefined, context: GuardContext, inside: string | undefined): void {
	if (inSet(ROOT_KINDS, node.kind)) {
		if (parent !== undefined) {
			throw new QueryRefusedError('statement_shape', 'subqueries are not allowed')
		}
		return
	}
	if (!inSet(NODE_KINDS, node.kind)) {
		throw new QueryRefusedError('statement_shape', `${String(node.kind)} is not allowed`)
	}
	switch (node.kind) {
		case 'RawNode':
			return checkRaw(node, parent)
		case 'SelectModifierNode':
			return checkLock(node, parent, context)
		case 'OnConflictNode':
			return checkConflict(node, parent, context)
		case 'CastNode':
			return checkCast(node, parent, context)
		case 'DataTypeNode':
			if (parent?.node.kind !== 'CastNode' || parent.key !== 'dataType' || read(node, 'dataType') !== 'text') {
				throw new QueryRefusedError('statement_shape', 'a data type appears only as the text of a selected column')
			}
			return
		case 'SchemableIdentifierNode':
			if (read(node, 'schema') !== undefined) {
				throw new QueryRefusedError('statement_shape', 'schema-qualified tables are not allowed')
			}
			return
		case 'IdentifierNode':
			if (!isPlainAlias(read(node, 'name'))) {
				throw new QueryRefusedError('statement_shape', 'identifiers must be plain names')
			}
			return
		case 'TableNode':
			return checkTable(node, parent, context, inside)
		case 'OrderByItemNode': {
			// Kysely prints `nulls` as raw text; the layer only ever states the order Postgres has by default.
			const nulls = read(node, 'nulls')
			if (nulls !== undefined && nulls !== 'first' && nulls !== 'last') {
				throw new QueryRefusedError('statement_shape', 'an order term states nulls first or nulls last, nothing else')
			}
			return
		}
		case 'JoinNode':
			return checkJoin(node, context)
		case 'ReferenceNode':
			if (read(node, 'table') === undefined) {
				throw new QueryRefusedError('statement_shape', 'column references must be table-qualified')
			}
			return
		case 'ColumnNode':
			if (
				parent === undefined
				|| !(parent.node.kind === 'ReferenceNode' || parent.node.kind === 'InsertQueryNode' || parent.node.kind === 'ColumnUpdateNode'
					|| parent.node.kind === 'OnConflictNode')
			) {
				throw new QueryRefusedError('statement_shape', 'unqualified column')
			}
			return
		case 'SelectAllNode':
			if (parent?.node.kind !== 'AggregateFunctionNode' || read(parent.node, 'func') !== 'count') {
				throw new QueryRefusedError('statement_shape', 'select * is not allowed; name the columns')
			}
			return
		case 'OperatorNode':
			return checkOperator(node, parent)
		case 'AggregateFunctionNode':
			if (
				!inSet(AGGREGATES, read(node, 'func')) || read(node, 'distinct') === true || read(node, 'filter') !== undefined
				|| read(node, 'over') !== undefined
			) {
				throw new QueryRefusedError('statement_shape', 'aggregate function not allowed')
			}
			return
		case 'ValueNode':
			return checkValue(node)
		default:
			return
	}
}

function checkOperator(node: OperationNode, parent: Visit | undefined): void {
	const operator = read(node, 'operator')
	if (inSet(COMPARISON_OPERATORS, operator)) {
		return
	}
	if (operator === 'not' && parent?.node.kind === 'UnaryOperationNode') {
		return
	}
	// The version bump `version = version + 1` is the one arithmetic the layer writes, as a SET value.
	if (operator === '+' && parent?.up?.node.kind === 'ColumnUpdateNode') {
		return
	}
	throw new QueryRefusedError('statement_shape', 'operator not allowed')
}

function checkValue(node: OperationNode): void {
	const value = read(node, 'value')
	if (read(node, 'immediate') === true) {
		if (value !== null && typeof value !== 'boolean') {
			throw new QueryRefusedError('statement_shape', 'inline values are allowed for null and booleans only')
		}
		return
	}
	const type = typeof value
	const plain = type === 'string' || type === 'number' || type === 'bigint' || type === 'boolean' || value === null || value instanceof Date
	if (!plain) {
		// Bun.SQL mis-binds a JS array and stores a bound JSON string as a JSON string, so only scalars are bound.
		throw new QueryRefusedError('statement_shape', 'only plain values are bound as parameters')
	}
}

/** The lock modifiers each lock kind admits, in the order the compiler prints them. */
const LOCKS: Readonly<Record<'share' | 'update' | 'claim', readonly string[]>> = freeze({
	share: freeze(['ForShare']),
	update: freeze(['ForUpdate']),
	claim: freeze(['ForUpdate', 'SkipLocked']),
})

function checkLock(node: OperationNode, parent: Visit | undefined, context: GuardContext): void {
	const modifiers = parent === undefined ? undefined : read(parent.node, 'endModifiers')
	const expected = context.lock === undefined ? [] : LOCKS[context.lock]
	const onRoot = parent !== undefined && parent.up === undefined && parent.key === 'endModifiers' && isArray(modifiers)
		&& modifiers.length === expected.length
	let position = -1
	for (let index = 0; onRoot && index < modifiers.length; index++) {
		if (modifiers[index] === node) {
			position = index
		}
	}
	const plain = position !== -1 && read(node, 'modifier') === expected[position] && read(node, 'of') === undefined
		&& read(node, 'rawModifier') === undefined
	if (!onRoot || !plain) {
		throw new QueryRefusedError('statement_shape', 'row locks are not allowed')
	}
}

/** `on conflict (<columns>) do nothing` on the root insert: no constraint name, index expression, WHERE or update. */
function checkConflict(node: OperationNode, parent: Visit | undefined, context: GuardContext): void {
	const columns = read(node, 'columns')
	const onRoot = parent !== undefined && parent.up === undefined && parent.key === 'onConflict' && context.onConflict === 'nothing'
	const plain = read(node, 'doNothing') === true && isArray(columns) && columns.length > 0 && read(node, 'constraint') === undefined
		&& read(node, 'indexExpression') === undefined && read(node, 'indexWhere') === undefined && read(node, 'updates') === undefined
		&& read(node, 'updateWhere') === undefined
	if (!onRoot || !plain) {
		throw new QueryRefusedError('statement_shape', 'an insert admits only on conflict (columns) do nothing')
	}
}

/** `cast(<own column> as text) as <alias>`, selected at the top of a select: nothing else casts. */
function checkCast(node: OperationNode, parent: Visit | undefined, context: GuardContext): void {
	const selected = parent?.node.kind === 'AliasNode' && parent.key === 'node' && parent.up?.node.kind === 'SelectionNode'
		&& parent.up.up?.node.kind === 'SelectQueryNode' && parent.up.up.up === undefined && parent.up.up.key === 'selections'
	if (context.root !== 'SelectQueryNode' || !selected || !isOwnColumn(read(node, 'expression'), context.table)) {
		throw new QueryRefusedError('statement_shape', 'a cast appears only as the text of a selected column of the statement table')
	}
}

function checkRaw(node: OperationNode, parent: Visit | undefined): void {
	const fragments = read(node, 'sqlFragments')
	const parameters = read(node, 'parameters')
	const isDirection = parent !== undefined && parent.node.kind === 'OrderByItemNode' && parent.key === 'direction'
	const isPlainDirection = isArray(fragments) && fragments.length === 1 && (fragments[0] === 'asc' || fragments[0] === 'desc')
	const hasNoParameters = isArray(parameters) && parameters.length === 0
	if (!isDirection || !isPlainDirection || !hasNoParameters) {
		throw new QueryRefusedError('statement_shape', 'raw SQL is not allowed')
	}
}

function checkTable(node: OperationNode, parent: Visit | undefined, context: GuardContext, inside: string | undefined): void {
	const name = tableName(node)
	// Inside an admitted subquery its own table is the one it reads, and the outer statement's is not reachable.
	if (inside !== undefined) {
		if (name === inside) {
			return
		}
		throw new QueryRefusedError('statement_shape', `a scope subquery of ${inside} reads ${String(name)}`)
	}
	if (name === context.table) {
		return
	}
	const isJoinTarget = parent?.node.kind === 'JoinNode' && parent.key === 'table'
	const isColumnQualifier = parent?.node.kind === 'ReferenceNode'
	if (name !== undefined && foreignKeyOf(context, name) !== undefined && (isJoinTarget || isColumnQualifier)) {
		return
	}
	throw new QueryRefusedError('statement_shape', `table ${String(name)} is not reachable from ${context.table}`)
}

function checkJoin(node: OperationNode, context: GuardContext): void {
	const child = tableName(read(node, 'table'))
	const pairs = child === undefined ? undefined : foreignKeyOf(context, child)
	if (context.root !== 'SelectQueryNode' || read(node, 'joinType') !== 'InnerJoin' || child === undefined || pairs === undefined) {
		throw new QueryRefusedError('statement_shape', 'only inner joins to declared children are allowed')
	}
	const on = read(read(node, 'on'), 'on')
	const withConditions = kindOf(on) === 'AndNode' && kindOf(read(on, 'right')) === 'ParensNode'
	const matches = isForeignKey(on, child, context.table, pairs) || (withConditions && isForeignKey(read(on, 'left'), child, context.table, pairs))
	if (!matches) {
		throw new QueryRefusedError('statement_shape', `the join of ${child} must be ON its composite foreign key`)
	}
}

function foreignKeyOf(context: GuardContext, child: string): readonly ForeignKeyPair[] | undefined {
	return hasOwn(context.joins, child) ? context.joins[child] : undefined
}

/** `child.c1 = parent.p1 and child.c2 = parent.p2 …`, left-nested, in the declared order. */
function isForeignKey(node: unknown, child: string, parent: string, pairs: readonly ForeignKeyPair[]): boolean {
	let rest = node
	for (let index = pairs.length - 1; index > 0; index--) {
		const pair = pairs[index]
		if (
			pair === undefined || kindOf(rest) !== 'AndNode' || !isColumnEquality(read(rest, 'right'), child, pair.childColumn, parent, pair.parentColumn)
		) {
			return false
		}
		rest = read(rest, 'left')
	}
	const first = pairs[0]
	return first !== undefined && isColumnEquality(rest, child, first.childColumn, parent, first.parentColumn)
}

function isColumnEquality(node: unknown, leftTable: string, leftColumn: string, rightTable: string, rightColumn: string): boolean {
	return kindOf(node) === 'BinaryOperationNode'
		&& read(read(node, 'operator'), 'operator') === '='
		&& isReference(read(node, 'leftOperand'), leftTable, leftColumn)
		&& isReference(read(node, 'rightOperand'), rightTable, rightColumn)
}

function isReference(node: unknown, table: string, column: string): boolean {
	return kindOf(node) === 'ReferenceNode' && tableName(read(node, 'table')) === table && read(read(read(node, 'column'), 'column'), 'name') === column
}

function isOperationNode(value: unknown): value is OperationNode {
	return typeof value === 'object' && value !== null && typeof read(value, 'kind') === 'string'
}

function kindOf(node: unknown): unknown {
	return read(node, 'kind')
}

/** An own data property, or undefined. An accessor is refused: the guard never runs a getter. */
function read(node: unknown, key: string): unknown {
	if (typeof node !== 'object' || node === null) {
		return undefined
	}
	const descriptor = ownDescriptor(node, key)
	if (descriptor === undefined) {
		return undefined
	}
	if (!hasOwn(descriptor, 'value')) {
		throw new QueryRefusedError('statement_shape', `accessor properties are not allowed in an operation tree (${key})`)
	}
	return descriptor.value
}

/** TableNode → SchemableIdentifierNode → IdentifierNode.name */
function tableName(node: unknown): string | undefined {
	const name = read(read(read(node, 'table'), 'identifier'), 'name')
	return isPlainIdentifier(name) ? name : undefined
}
