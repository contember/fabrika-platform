// The leak sweep's sample of an input schema: a value each shape admits, or none where it cannot meet the shape.

import type { NumberShape, SchemaShape, StringShape } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { sampleOf } from '../testing/sample-input'

const text = (shape: Partial<StringShape> = {}): SchemaShape => ({
	type: 'string',
	format: null,
	pattern: null,
	minLength: null,
	maxLength: null,
	startsWith: null,
	endsWith: null,
	includes: null,
	...shape,
})
const number = (shape: Partial<NumberShape> = {}): SchemaShape => ({
	type: 'number',
	int: false,
	min: null,
	max: null,
	exclusiveMin: false,
	exclusiveMax: false,
	multipleOf: null,
	...shape,
})

describe('the sample of an input schema', () => {
	test('a string meets its format, length and affixes; a pattern has no sample', () => {
		expect(sampleOf(text({ format: 'uuid' }))).toBe('00000000-0000-4000-8000-000000000000')
		expect(sampleOf(text({ minLength: 3, startsWith: 'a' }))).toBe('axx')
		expect(sampleOf(text({ maxLength: 2, startsWith: 'abc' }))).toBeUndefined()
		expect(sampleOf(text({ pattern: '^x$' }))).toBeUndefined()
	})

	test('a number meets its bounds: exclusive, fractional, negative, a step', () => {
		expect(sampleOf(number({ int: true, min: 0, exclusiveMin: true }))).toBe(1)
		expect(sampleOf(number({ max: 0, exclusiveMax: true }))).toBe(-1)
		expect(sampleOf(number({ int: true, max: 0, exclusiveMax: true }))).toBe(-1)
		expect(sampleOf(number({ min: 0.1, max: 0.5 }))).toBe(0.1)
		expect(sampleOf(number({ min: 0, max: 1, exclusiveMin: true, exclusiveMax: true }))).toBe(0.5)
		expect(sampleOf(number({ int: true, min: 10, max: 20, multipleOf: 5 }))).toBe(10)
		expect(sampleOf(number({ int: true, min: 2, max: 1 }))).toBeUndefined()
	})

	test('an object samples each required field, leaves an optional one out, and fails with any field', () => {
		const shape: SchemaShape = {
			type: 'object',
			fields: { id: text({ format: 'uuid' }), note: { type: 'optional', inner: text() }, kind: { type: 'enum', values: ['a', 'b'] } },
		}
		expect(sampleOf(shape)).toEqual({ id: '00000000-0000-4000-8000-000000000000', kind: 'a' })
		expect(sampleOf({ type: 'object', fields: { code: text({ pattern: '^x$' }) } })).toBeUndefined()
	})

	test('a file field holds its kind marker, which the kit sends as a sample file', () => {
		expect(sampleOf({ type: 'file', kind: 'photos' })).toBe('fabrika:file:photos')
	})
})
