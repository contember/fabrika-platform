// The predicate of a structured row condition, and the one subquery shape a scope predicate holds. Apart from the
// parse in `conditions.ts`, which `@fabrika/db/tables` loads in a browser without Kysely.

import {
	BinaryOperationNode,
	ColumnNode,
	type OperationNode,
	OperatorNode,
	ParensNode,
	QueryNode,
	ReferenceNode,
	SelectionNode,
	SelectQueryNode,
	TableNode,
	UnaryOperationNode,
	ValueListNode,
	ValueNode,
} from 'kysely'
import { isArray } from './builtins'
import { type ConditionHop, type ConditionLiteral, type ConditionModel, NOW, type NowOperand, scalar } from './conditions'
import { allOf, anyOf, column } from './nodes'

function comparison(operator: 'eq' | 'notEq' | 'lt' | 'lte' | 'gt' | 'gte'): OperatorNode {
	switch (operator) {
		case 'eq':
			return OperatorNode.create('=')
		case 'notEq':
			return OperatorNode.create('<>')
		case 'lt':
			return OperatorNode.create('<')
		case 'lte':
			return OperatorNode.create('<=')
		case 'gt':
			return OperatorNode.create('>')
		case 'gte':
			return OperatorNode.create('>=')
	}
}

/** The predicate of `condition` over `table`'s rows; `now` is the statement's clock, bound as a value. */
export function conditionNode(table: string, condition: ConditionModel, now: Date): OperationNode {
	switch (condition.kind) {
		case 'all':
			return ParensNode.create(allOf(nodesOf(table, condition.terms, now)))
		case 'any':
			return anyOf(nodesOf(table, condition.terms, now))
		case 'not':
			return UnaryOperationNode.create(OperatorNode.create('not'), ParensNode.create(conditionNode(table, condition.term, now)))
		case 'test':
			return testNode(table, condition.hops, 0, condition, now)
	}
}

function nodesOf(table: string, terms: readonly ConditionModel[], now: Date): OperationNode[] {
	const nodes: OperationNode[] = []
	for (let index = 0; index < terms.length; index++) {
		const term = terms[index]
		if (term !== undefined) nodes[nodes.length] = conditionNode(table, term, now)
	}
	return nodes
}

/** `table.fk in (select target.key from target where …)` per hop, then the column's own test. */
function testNode(
	table: string,
	hops: readonly ConditionHop[],
	position: number,
	test: Extract<ConditionModel, { kind: 'test' }>,
	now: Date,
): OperationNode {
	const hop = hops[position]
	if (hop !== undefined) {
		const inner = testNode(hop.table, hops, position + 1, test, now)
		return BinaryOperationNode.create(column(table, hop.column), OperatorNode.create('in'), subquery(hop.table, hop.key, inner))
	}
	const left = column(table, test.column)
	const value = test.value
	switch (test.operator) {
		case 'isNull':
			return BinaryOperationNode.create(left, OperatorNode.create(value === true ? 'is' : 'is not'), ValueNode.createImmediate(null))
		case 'in':
		case 'notIn':
			return BinaryOperationNode.create(left, OperatorNode.create(test.operator === 'in' ? 'in' : 'not in'), ValueListNode.create(literals(value)))
		default:
			return BinaryOperationNode.create(left, comparison(test.operator), ValueNode.create(value === NOW ? now : scalar(value)))
	}
}

function literals(value: ConditionLiteral | readonly ConditionLiteral[] | boolean | NowOperand): ValueNode[] {
	const nodes: ValueNode[] = []
	if (isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			nodes[nodes.length] = ValueNode.create(value[index])
		}
	}
	return nodes
}

/** `select table.key from table where <where>`: the one subquery shape the guard admits in a scope predicate. */
export function subquery(table: string, key: string, where: OperationNode): OperationNode {
	const select = SelectQueryNode.cloneWithSelections(SelectQueryNode.createFrom([TableNode.create(table)]), [
		SelectionNode.create(ReferenceNode.create(ColumnNode.create(key), TableNode.create(table))),
	])
	return QueryNode.cloneWithWhere(select, where)
}
