import type { ContractArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { capsJobSegments, needsMinuteTick, pinsGeneratedEntry, releaseAtLeast, runsInObject, servesAlarms } from '../contract-support'

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
		test(`${release}: runsInObject, pinsGeneratedEntry, capsJobSegments and servesAlarms are all ${expected}`, () => {
			expect(runsInObject(release)).toBe(expected)
			expect(pinsGeneratedEntry(release)).toBe(expected)
			expect(capsJobSegments(release)).toBe(expected)
			expect(servesAlarms(release)).toBe(expected)
		})
	}
})

describe('needsMinuteTick', () => {
	const collectionsOnly: ContractArtifact = { ...notesArtifact, jobs: {}, fileKinds: {} }

	test('legacy file collections alone get no tick: the object schedules no sweep of theirs', () => {
		expect(Object.keys(collectionsOnly.files).length).toBeGreaterThan(0)
		expect(needsMinuteTick(collectionsOnly)).toBe(false)
	})

	test('a job or a file kind gets the tick', () => {
		expect(Object.keys(notesArtifact.jobs).length).toBeGreaterThan(0)
		expect(needsMinuteTick({ ...collectionsOnly, jobs: notesArtifact.jobs })).toBe(true)
		expect(needsMinuteTick({ ...collectionsOnly, fileKinds: { photo: { types: ['image/png'], maxBytes: 1024 } } })).toBe(true)
	})
})
