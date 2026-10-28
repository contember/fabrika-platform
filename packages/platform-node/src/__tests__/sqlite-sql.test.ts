import { describe, expect, test } from 'bun:test'
import { lexSqlite, statementsOf } from '../sql'

const kinds = (sql: string) =>
	lexSqlite(sql).tokens.map((token) => (token.kind === 'punct' ? token.char : `${token.kind}:${token.kind === 'dollar' ? token.body : token.text}`))

describe("SQLite's lexical rules", () => {
	test('strings double their quote; names are "…", `…` (each doubled) and […] (no escape)', () => {
		expect(kinds(`select 'it''s', "a""b", \`c\`\`d\`, [e"f]`)).toEqual([
			'word:select',
			"string:it's",
			',',
			'quoted:a"b',
			',',
			'quoted:c`d',
			',',
			'quoted:e"f',
		])
	})

	test('no E string and no dollar quoting: a backslash ends nothing and a $ is a character of its own', () => {
		expect(kinds(`select E'\\'; x`)).toEqual(['word:select', 'word:E', 'string:\\', ';', 'word:x'])
		expect(kinds('select $$ x $$')).toEqual(['word:select', '$', '$', 'word:x', '$', '$'])
		expect(kinds('select a$b')).toEqual(['word:select', 'word:a$b'])
	})

	test('a block comment does not nest, a line comment ends at a line feed only, and a byte-order mark is space', () => {
		expect(statementsOf(lexSqlite('select 1 /* /* */ ; select 2 */').tokens)).toHaveLength(2)
		expect(statementsOf(lexSqlite('select 1 -- x\r; select 2').tokens)).toHaveLength(1)
		expect(statementsOf(lexSqlite('select 1 -- x\n; select 2').tokens)).toHaveLength(2)
		expect(kinds('select ﻿fabrika_x')).toEqual(['word:select', 'word:fabrika_x'])
	})

	test('reports the line of what never closes', () => {
		expect(lexSqlite("select 1\n'open").unterminated).toBe(2)
		expect(lexSqlite('select [open').unterminated).toBe(1)
		expect(lexSqlite('select 1 /* open').unterminated).toBe(1)
		expect(lexSqlite('select `a`').unterminated).toBeUndefined()
	})
})
