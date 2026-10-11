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
	 * `getForUpdate` of its own target. No other lock is admitted.
	 */
	readonly lock?: 'share' | 'update'
}

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
	// Only as the one lock of a destination check or a getForUpdate; checked below.
	'SelectModifierNode',
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
		throw new QueryRefusedError(`expected a ${context.root}, got ${String(root.kind)}`)
	}
	const allowed = ROOT_PROPERTIES[context.root]
	const keys = ownKeys(root)
	for (let index = 0; index < keys.length; index++) {
		const key = keys[index] ?? ''
		const lockModifier = key === 'endModifiers' && context.lock !== undefined && context.root === 'SelectQueryNode'
		if (read(root, key) !== undefined && !inSet(allowed, key) && !lockModifier) {
			throw new QueryRefusedError(`${context.root}.${key} is not allowed`)
		}
	}
	checkRoot(root, context)
	walk(root, undefined, context)
}

function checkRoot(root: OperationNode, context: GuardContext): void {
	const target = context.root === 'InsertQueryNode'
		? read(root, 'into')
		: context.root === 'UpdateQueryNode'
		? read(root, 'table')
		: soleFrom(read(root, 'from'))
	if (tableName(target) !== context.table) {
		throw new QueryRefusedError(`the statement must address ${context.table} only`)
	}
	const where = read(root, 'where')
	if (context.scope === undefined) {
		if (context.root !== 'InsertQueryNode' || where !== undefined) {
			throw new QueryRefusedError('a statement without its scope predicate is not allowed')
		}
		return
	}
	const predicate = read(where, 'where')
	const scoped = predicate === context.scope
		|| (kindOf(predicate) === 'AndNode' && read(predicate, 'right') === context.scope && kindOf(read(predicate, 'left')) === 'ParensNode')
	if (!scoped) {
		throw new QueryRefusedError('the scope predicate must be the top-level conjunct of WHERE')
	}
	const scope = context.scope
	const membership = (leaf: unknown) => isScopeMembership(leaf, context.table)
	const shaped = isEverything(scope)
		|| isTreeOf(scope, 'AndNode', (leaf) => isScopeEquality(leaf, context.table))
		|| membership(scope)
		|| (kindOf(scope) === 'ParensNode' && kindOf(read(scope, 'node')) === 'OrNode' && isTreeOf(read(scope, 'node'), 'OrNode', membership))
	if (!shaped) {
		throw new QueryRefusedError(
			'the scope predicate must be true, an AND of column = value, or a parenthesized OR of column in (values), over the statement table',
		)
	}
}

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
		throw new QueryRefusedError('exactly one table in FROM')
	}
	return froms[0]
}

function walk(node: OperationNode, parent: Visit | undefined, context: GuardContext): void {
	checkNode(node, parent, context)
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
				walk(child, { node, key, up: parent }, context)
			} else if (typeof child === 'object' && child !== null) {
				throw new QueryRefusedError(`unexpected structure under ${node.kind}.${key}`)
			}
		}
	}
}

function checkNode(node: OperationNode, parent: Visit | undefined, context: GuardContext): void {
	if (inSet(ROOT_KINDS, node.kind)) {
		if (parent !== undefined) {
			throw new QueryRefusedError('subqueries are not allowed')
		}
		return
	}
	if (!inSet(NODE_KINDS, node.kind)) {
		throw new QueryRefusedError(`${String(node.kind)} is not allowed`)
	}
	switch (node.kind) {
		case 'RawNode':
			return checkRaw(node, parent)
		case 'SelectModifierNode':
			return checkLock(node, parent, context)
		case 'SchemableIdentifierNode':
			if (read(node, 'schema') !== undefined) {
				throw new QueryRefusedError('schema-qualified tables are not allowed')
			}
			return
		case 'IdentifierNode':
			if (!isPlainAlias(read(node, 'name'))) {
				throw new QueryRefusedError('identifiers must be plain names')
			}
			return
		case 'TableNode':
			return checkTable(node, parent, context)
		case 'JoinNode':
			return checkJoin(node, context)
		case 'ReferenceNode':
			if (read(node, 'table') === undefined) {
				throw new QueryRefusedError('column references must be table-qualified')
			}
			return
		case 'ColumnNode':
			if (
				parent === undefined
				|| !(parent.node.kind === 'ReferenceNode' || parent.node.kind === 'InsertQueryNode' || parent.node.kind === 'ColumnUpdateNode')
			) {
				throw new QueryRefusedError('unqualified column')
			}
			return
		case 'SelectAllNode':
			if (parent?.node.kind !== 'AggregateFunctionNode' || read(parent.node, 'func') !== 'count') {
				throw new QueryRefusedError('select * is not allowed; name the columns')
			}
			return
		case 'OperatorNode':
			return checkOperator(node, parent)
		case 'AggregateFunctionNode':
			if (
				!inSet(AGGREGATES, read(node, 'func')) || read(node, 'distinct') === true || read(node, 'filter') !== undefined
				|| read(node, 'over') !== undefined
			) {
				throw new QueryRefusedError('aggregate function not allowed')
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
	// The version bump `version = version + 1` is the one arithmetic the layer writes, as a SET value.
	if (operator === '+' && parent?.up?.node.kind === 'ColumnUpdateNode') {
		return
	}
	throw new QueryRefusedError('operator not allowed')
}

function checkValue(node: OperationNode): void {
	const value = read(node, 'value')
	if (read(node, 'immediate') === true) {
		if (value !== null && typeof value !== 'boolean') {
			throw new QueryRefusedError('inline values are allowed for null and booleans only')
		}
		return
	}
	const type = typeof value
	const plain = type === 'string' || type === 'number' || type === 'bigint' || type === 'boolean' || value === null || value instanceof Date
	if (!plain) {
		// Bun.SQL mis-binds a JS array and stores a bound JSON string as a JSON string, so only scalars are bound.
		throw new QueryRefusedError('only plain values are bound as parameters')
	}
}

function checkLock(node: OperationNode, parent: Visit | undefined, context: GuardContext): void {
	const modifiers = parent === undefined ? undefined : read(parent.node, 'endModifiers')
	const onRoot = parent !== undefined && parent.up === undefined && parent.key === 'endModifiers' && isArray(modifiers) && modifiers.length === 1
	const expected = context.lock === 'share' ? 'ForShare' : context.lock === 'update' ? 'ForUpdate' : undefined
	const plain = expected !== undefined && read(node, 'modifier') === expected && read(node, 'of') === undefined
		&& read(node, 'rawModifier') === undefined
	if (!onRoot || !plain) {
		throw new QueryRefusedError('row locks are not allowed')
	}
}

function checkRaw(node: OperationNode, parent: Visit | undefined): void {
	const fragments = read(node, 'sqlFragments')
	const parameters = read(node, 'parameters')
	const isDirection = parent !== undefined && parent.node.kind === 'OrderByItemNode' && parent.key === 'direction'
	const isPlainDirection = isArray(fragments) && fragments.length === 1 && (fragments[0] === 'asc' || fragments[0] === 'desc')
	const hasNoParameters = isArray(parameters) && parameters.length === 0
	if (!isDirection || !isPlainDirection || !hasNoParameters) {
		throw new QueryRefusedError('raw SQL is not allowed')
	}
}

function checkTable(node: OperationNode, parent: Visit | undefined, context: GuardContext): void {
	const name = tableName(node)
	if (name === context.table) {
		return
	}
	const isJoinTarget = parent?.node.kind === 'JoinNode' && parent.key === 'table'
	const isColumnQualifier = parent?.node.kind === 'ReferenceNode'
	if (name !== undefined && foreignKeyOf(context, name) !== undefined && (isJoinTarget || isColumnQualifier)) {
		return
	}
	throw new QueryRefusedError(`table ${String(name)} is not reachable from ${context.table}`)
}

function checkJoin(node: OperationNode, context: GuardContext): void {
	const child = tableName(read(node, 'table'))
	const pairs = child === undefined ? undefined : foreignKeyOf(context, child)
	if (context.root !== 'SelectQueryNode' || read(node, 'joinType') !== 'InnerJoin' || child === undefined || pairs === undefined) {
		throw new QueryRefusedError('only inner joins to declared children are allowed')
	}
	const on = read(read(node, 'on'), 'on')
	const withConditions = kindOf(on) === 'AndNode' && kindOf(read(on, 'right')) === 'ParensNode'
	const matches = isForeignKey(on, child, context.table, pairs) || (withConditions && isForeignKey(read(on, 'left'), child, context.table, pairs))
	if (!matches) {
		throw new QueryRefusedError(`the join of ${child} must be ON its composite foreign key`)
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
		throw new QueryRefusedError(`accessor properties are not allowed in an operation tree (${key})`)
	}
	return descriptor.value
}

/** TableNode → SchemableIdentifierNode → IdentifierNode.name */
function tableName(node: unknown): string | undefined {
	const name = read(read(read(node, 'table'), 'identifier'), 'name')
	return isPlainIdentifier(name) ? name : undefined
}
