import { describe, expect, test } from 'bun:test'
import { pinsGeneratedEntry, releaseAtLeast, runsInObject } from '../contract-support'

describe('releaseAtLeast', () => {
	const since = { major: 0, minor: 9 }
	const cases: ReadonlyArray<readonly [string, boolean]> = [
		['0.8.5', false],
		['0.9.0', true],
		['0.10.0', true],
		['1.0.0', true],
		['1.2.3', true],
		['0.9.0-dev.3', true],
		['0.8.9-dev.1', false],
		['0.9', false],
		['v0.9.0', false],
		['latest', false],
		['', false],
	]
	for (const [release, expected] of cases) {
		test(`${JSON.stringify(release)} is ${expected ? 'at least' : 'below'} 0.9`, () => {
			expect(releaseAtLeast(release, since)).toBe(expected)
		})
	}

	test('a major bump wins over a lower minor', () => {
		expect(releaseAtLeast('2.0.0', { major: 1, minor: 5 })).toBe(true)
		expect(releaseAtLeast('1.4.9', { major: 1, minor: 5 })).toBe(false)
		expect(releaseAtLeast('0.99.0', { major: 1, minor: 0 })).toBe(false)
	})
})

describe('the release gates', () => {
	const cases: ReadonlyArray<readonly [string, boolean]> = [
		['0.8.0', false],
		['0.8.12', false],
		['0.9.0', true],
		['0.9.0-dev.1', true],
		['1.0.0', true],
	]
	for (const [release, expected] of cases) {
		test(`${release}: runsInObject and pinsGeneratedEntry are both ${expected}`, () => {
			expect(runsInObject(release)).toBe(expected)
			expect(pinsGeneratedEntry(release)).toBe(expected)
		})
	}
})
