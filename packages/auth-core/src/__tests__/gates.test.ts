import { describe, expect, test } from 'bun:test'
import { applicableGates, compileGates } from '../gates'
import type { AppGates } from '../types'

const matchingPaths = (gates: AppGates, pathname: string): string[] => applicableGates(compileGates(gates), pathname).map(({ rule }) => rule.path)

describe('gate path contract from ADR-0010', () => {
	test('globs are anchored and case-sensitive', () => {
		const gates: AppGates = { rules: [{ path: '/Admin/*', kind: 'public' }] }
		expect(matchingPaths(gates, '/Admin/users')).toEqual(['/Admin/*'])
		expect(matchingPaths(gates, '/admin/users')).toEqual([])
		expect(matchingPaths(gates, '/x/Admin/users')).toEqual([])
	})

	test('a wildcard crosses path separators', () => {
		const gates: AppGates = { rules: [{ path: '/api/*/items', kind: 'public' }] }
		expect(matchingPaths(gates, '/api/a/b/items')).toEqual(['/api/*/items'])
	})

	test('matching preserves repeated slashes', () => {
		const gates: AppGates = { rules: [{ path: '/public/*', kind: 'public' }, { path: '//*', kind: 'human' }] }
		expect(matchingPaths(gates, '//public/health')).toEqual(['//*'])
	})

	test('matching rules remain in declaration order', () => {
		const gates: AppGates = {
			rules: [{ path: '/*', kind: 'service' }, { path: '/api/*', kind: 'human' }, { path: '/*', kind: 'public' }],
		}
		expect(applicableGates(compileGates(gates), '/api/items').map(({ rule }) => rule.kind)).toEqual(['service', 'human', 'public'])
	})

	test('regex punctuation in a gate path stays literal', () => {
		const gates: AppGates = { rules: [{ path: '/v1/items.+/*', kind: 'public' }] }
		expect(matchingPaths(gates, '/v1/items.+/one')).toEqual(['/v1/items.+/*'])
		expect(matchingPaths(gates, '/v1/itemsABC/one')).toEqual([])
	})
})
