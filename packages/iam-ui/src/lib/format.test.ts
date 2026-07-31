import { describe, expect, test } from 'bun:test'
import { trimmedQueryValue } from './format'

describe('trimmedQueryValue', () => {
	test('trims URL filter values', () => {
		expect(trimmedQueryValue('  principal-1  ')).toBe('principal-1')
	})

	test('omits absent and whitespace-only values', () => {
		expect(trimmedQueryValue(undefined)).toBeUndefined()
		expect(trimmedQueryValue(null)).toBeUndefined()
		expect(trimmedQueryValue('   ')).toBeUndefined()
	})
})
