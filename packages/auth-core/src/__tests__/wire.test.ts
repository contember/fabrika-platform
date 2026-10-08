import { describe, expect, test } from 'bun:test'
import * as wire from '../wire'
import { FABRIKA_HOP_HEADERS, FABRIKA_PROXY_SECRET, proxySecretVariable } from '../wire'

describe('the hop headers', () => {
	test('list every X-Fabrika-* name the wire module defines, so a new one cannot miss the strip', () => {
		const names: string[] = []
		for (const value of Object.values(wire)) {
			if (typeof value === 'string' && value.startsWith('X-Fabrika-')) {
				names.push(value)
			}
		}
		expect(names.length).toBeGreaterThan(0)
		for (const name of names) {
			expect(FABRIKA_HOP_HEADERS).toContain(name)
		}
		expect(new Set(FABRIKA_HOP_HEADERS).size).toBe(FABRIKA_HOP_HEADERS.length)
	})
})

describe('proxySecretVariable', () => {
	test('names one variable per application environment, under the framework prefix', () => {
		const prod = proxySecretVariable('notes@prod')
		expect(prod).toMatch(/^FABRIKA_PROXY_SECRET_[0-9A-F]{32}$/)
		expect(prod.startsWith(`${FABRIKA_PROXY_SECRET}_`)).toBe(true)
		expect(proxySecretVariable('notes@prod')).toBe(prod)
		expect(proxySecretVariable('notes@stage')).not.toBe(prod)
		expect(proxySecretVariable('notes-stage@prod')).not.toBe(prod)
	})

	test('stays a valid variable name for an environment name with any character', () => {
		expect(proxySecretVariable('notes@feature/one two')).toMatch(/^[A-Z_][A-Z0-9_]*$/)
	})
})
