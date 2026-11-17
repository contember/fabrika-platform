import { parse } from '@babel/parser'
import { describe, expect, test } from 'bun:test'
import { type AstNode, isNode, parseModule, positionOf, walk } from '../ast'

const SOURCE = [
	"import { z } from 'zod/v4'\r\n",
	'/* a block\r comment */ export const a = { b: [1, 2], c: `x\n${"y"}` }\r',
	'\tconst d = /re/g; // a line comment\u2028',
	"const e = '😀'; const f = e satisfies string\u2029",
	'export type G = { readonly h: number }\n',
	'function i(j: number): number { return j + 1 }\n',
].join('')

/** Every node's line and column as the parser reports them, in `walk` order. */
const parserPositions = (text: string): string[] => {
	const program: unknown = parse(text, { sourceType: 'module', plugins: ['typescript', 'estree'] }).program
	if (!isNode(program)) throw new Error('no program')
	const positions: string[] = []
	walk(program, (node) => {
		const loc = node['loc']
		const start = typeof loc === 'object' && loc !== null && 'start' in loc ? loc.start : undefined
		const line = typeof start === 'object' && start !== null && 'line' in start ? start.line : undefined
		const column = typeof start === 'object' && start !== null && 'column' in start && typeof start.column === 'number' ? start.column + 1 : undefined
		positions.push(`${node.type} ${String(line)}:${String(column)}`)
	})
	return positions
}

describe('positions', () => {
	test("every node's line and column are the parser's, across each kind of line break and astral characters", () => {
		const parsed = parseModule('src/sample.ts', SOURCE)
		if (!parsed.ok) throw new Error(parsed.message)
		const positions: string[] = []
		walk(parsed.module.program, (node: AstNode) => {
			const { line, column } = positionOf(node)
			positions.push(`${node.type} ${line}:${column}`)
		})
		const expected = parserPositions(SOURCE)
		expect(positions.length).toBeGreaterThan(50)
		expect(positions).toEqual(expected)
	})

	test("a comment's line and column are the parser's", () => {
		const parsed = parseModule('src/sample.ts', SOURCE)
		if (!parsed.ok) throw new Error(parsed.message)
		const comments = parse(SOURCE, { sourceType: 'module', plugins: ['typescript', 'estree'] }).comments ?? []
		expect(parsed.module.comments.map((comment) => `${comment.position.line}:${comment.position.column}`)).toEqual(
			comments.map((comment) => `${comment.loc?.start.line}:${(comment.loc?.start.column ?? 0) + 1}`),
		)
		expect(parsed.module.comments.map((comment) => `${comment.position.line}:${comment.position.column}`)).toEqual(['2:1', '5:19'])
	})
})
