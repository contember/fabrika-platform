import { describe, expect, test } from 'bun:test'
import { parseJsonStringArray } from '../index'

describe('parseJsonStringArray', () => {
	test('keeps the string entries of a JSON array', () => {
		expect(parseJsonStringArray('["a", 1, null, "b", {"c": 1}]')).toEqual(['a', 'b'])
	})

	test('yields [] for malformed or non-array JSON', () => {
		expect(parseJsonStringArray('[')).toEqual([])
		expect(parseJsonStringArray('{"a": "b"}')).toEqual([])
		expect(parseJsonStringArray('"a"')).toEqual([])
	})
})
