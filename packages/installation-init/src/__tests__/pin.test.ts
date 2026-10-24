import { expect, test } from 'bun:test'
import { assertPinnedTag } from '../pin'

test('a sidecar pins a published tag and never a branch', () => {
	expect(() => assertPinnedTag('main')).toThrow('is not a published tag')
	expect(() => assertPinnedTag('feature/x')).toThrow('never a branch')
	expect(() => assertPinnedTag('')).toThrow('a published fabrika tag is required')
	expect(assertPinnedTag(' v1.2.3 ')).toBe('v1.2.3')
	expect(assertPinnedTag('v0.0.1-rc.1')).toBe('v0.0.1-rc.1')
})
