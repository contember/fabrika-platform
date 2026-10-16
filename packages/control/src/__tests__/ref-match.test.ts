import { describe, expect, test } from 'bun:test'
import { canonicalTriggerRef, isRefPattern, refMatches, TriggerRefValidationError } from '../ref-match'

describe('canonicalTriggerRef', () => {
	test('a bare name is a branch; a full ref, a tag glob and a branch glob keep their form', () => {
		expect(canonicalTriggerRef('main')).toBe('refs/heads/main')
		expect(canonicalTriggerRef('deploy/prod')).toBe('refs/heads/deploy/prod')
		expect(canonicalTriggerRef('release/*')).toBe('refs/heads/release/*')
		expect(canonicalTriggerRef('refs/heads/deploy/prod')).toBe('refs/heads/deploy/prod')
		expect(canonicalTriggerRef('refs/tags/v*')).toBe('refs/tags/v*')
		expect(canonicalTriggerRef('refs/tags/v1.2.0')).toBe('refs/tags/v1.2.0')
	})

	test('the canonical form of a bare name matches the ref its push names', () => {
		expect(refMatches(canonicalTriggerRef('deploy/prod'), 'refs/heads/deploy/prod')).toBe(true)
	})

	test('a value with whitespace, a control character or an empty segment is refused', () => {
		for (const invalid of ['', ' ', 'refs/', 'refs/heads', 'refs/heads/', 'deploy prod', '\tmain', 'main\n', 'a//b', '/main', 'main/']) {
			expect(() => canonicalTriggerRef(invalid)).toThrow(TriggerRefValidationError)
		}
	})
})

describe('isRefPattern', () => {
	test('a ref with a * is a pattern; a plain ref is not', () => {
		expect(isRefPattern('refs/tags/v*')).toBe(true)
		expect(isRefPattern('refs/tags/*')).toBe(true)
		expect(isRefPattern('refs/heads/deploy/prod')).toBe(false)
		expect(isRefPattern('refs/tags/v1.2.3')).toBe(false)
	})
})

describe('refMatches', () => {
	test('exact trigger_ref matches only the identical ref', () => {
		expect(refMatches('refs/heads/deploy/prod', 'refs/heads/deploy/prod')).toBe(true)
		expect(refMatches('refs/heads/deploy/prod', 'refs/heads/deploy/stage')).toBe(false)
		expect(refMatches('refs/tags/v1.2.3', 'refs/tags/v1.2.3')).toBe(true)
		expect(refMatches('refs/tags/v1.2.3', 'refs/tags/v1.2.4')).toBe(false)
	})

	test('a v* tag pattern matches version tags but not other refs', () => {
		expect(refMatches('refs/tags/v*', 'refs/tags/v1.2.3')).toBe(true)
		expect(refMatches('refs/tags/v*', 'refs/tags/v0.0.1-rc.1')).toBe(true)
		expect(refMatches('refs/tags/v*', 'refs/tags/release-1')).toBe(false)
		// The literal prefix is preserved — a tag pattern never matches a branch ref.
		expect(refMatches('refs/tags/v*', 'refs/heads/v-branch')).toBe(false)
	})

	test('a bare * pattern matches any tag under the prefix', () => {
		expect(refMatches('refs/tags/*', 'refs/tags/v1.2.3')).toBe(true)
		expect(refMatches('refs/tags/*', 'refs/tags/anything/nested')).toBe(true)
		expect(refMatches('refs/tags/*', 'refs/heads/main')).toBe(false)
	})

	test('regex metacharacters in the pattern are matched literally (only * is special)', () => {
		// The `.` must be a literal dot, not "any char" — so `v1x2` does NOT match `refs/tags/v1.*`.
		expect(refMatches('refs/tags/v1.*', 'refs/tags/v1.2')).toBe(true)
		expect(refMatches('refs/tags/v1.*', 'refs/tags/v1x2')).toBe(false)
	})
})
