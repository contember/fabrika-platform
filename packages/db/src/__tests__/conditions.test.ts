// A structured condition's clock operand is the parsed `{ now: true }` only: the text `now` stays a literal.

import { describe, expect, test } from 'bun:test'
import { BinaryOperationNode, ValueNode } from 'kysely'
import { nameSet } from '../builtins'
import { conditionNode } from '../condition-nodes'
import { type ConditionTable, parseCondition, rowSatisfies } from '../conditions'

const tasks: ConditionTable = {
	name: 'tasks',
	columns: nameSet(['id', 'status', 'due_at']),
	foreignKeys: [],
	timestamps: nameSet(['due_at']),
	json: nameSet([]),
}
const parse = (input: unknown) => parseCondition(input, tasks, () => undefined, 'when', false)
const NOW = new Date('2026-01-01T00:00:00.000Z')

describe('the clock operand', () => {
	test("a literal 'now' is compared as text, on the row and in SQL", () => {
		const condition = parse({ status: { eq: 'now' } })
		expect(rowSatisfies(condition, new Map([['status', 'now']]), NOW)).toBe(true)
		expect(rowSatisfies(parse({ status: { notEq: 'now' } }), new Map([['status', 'now']]), NOW)).toBe(false)
		const node = conditionNode('tasks', condition, NOW)
		const right = BinaryOperationNode.is(node) && ValueNode.is(node.rightOperand) ? node.rightOperand.value : undefined
		expect(right).toBe('now')
	})

	test('{ now: true } is the statement clock', () => {
		const condition = parse({ due_at: { lt: { now: true } } })
		expect(rowSatisfies(condition, new Map([['due_at', new Date('2025-12-31T00:00:00.000Z')]]), NOW)).toBe(true)
		const node = conditionNode('tasks', condition, NOW)
		const right = BinaryOperationNode.is(node) && ValueNode.is(node.rightOperand) ? node.rightOperand.value : undefined
		expect(right).toBe(NOW)
	})
})
