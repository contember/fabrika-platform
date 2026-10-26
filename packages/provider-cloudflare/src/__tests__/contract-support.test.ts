import type { ContractArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import {
	capsJobSegments,
	needsMinuteTick,
	pinsGeneratedEntry,
	releaseAtLeast,
	releaseFrom,
	runsInObject,
	servesAlarms,
	servesDataOperations,
	servesOps,
	servesRawSql,
} from '../contract-support'
import { PUBLISHED_PRERELEASES } from './published-prereleases'

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

describe('releaseFrom', () => {
	const cases: ReadonlyArray<readonly [string, string, boolean]> = [
		['0.9.0', '0.9.0-dev.5', true],
		['0.9.0-dev.5', '0.9.0-dev.5', true],
		['0.9.0-dev.10', '0.9.0-dev.5', true],
		['0.9.0-dev.4', '0.9.0-dev.5', false],
		['0.9.0-dev', '0.9.0-dev.5', false],
		['0.9.0-dev.5.1', '0.9.0-dev.5', true],
		['0.9.0-local.gabc1234', '0.9.0-dev.5', true],
		['0.9.0-cloudflare.9', '0.9.0-dev.5', false],
		['0.9.0-1', '0.9.0-dev.5', false],
		['0.9.1-alpha.0', '0.9.0-dev.5', true],
		['0.9.0+build.7', '0.9.0', true],
		['1.0.0-rc.1', '1.0.0', false],
		['0.8.9', '0.9.0-dev.5', false],
		['0.9', '0.9.0-dev.5', false],
		['v0.9.0', '0.9.0-dev.5', false],
		['', '0.9.0-dev.5', false],
	]
	for (const [release, since, expected] of cases) {
		test(`${JSON.stringify(release)} is ${expected ? 'from' : 'before'} ${since}`, () => {
			expect(releaseFrom(release, since)).toBe(expected)
		})
	}

	test('a floor that is not a version is a programming error', () => {
		expect(() => releaseFrom('0.9.0', '0.9')).toThrow('is not a semver version')
	})
})

describe('the release gates', () => {
	const cases: ReadonlyArray<readonly [string, boolean]> = [
		['0.8.0', false],
		['0.8.12', false],
		['0.9.0', true],
		['0.9.0-dev.5', true],
		['1.0.0', true],
	]
	for (const [release, expected] of cases) {
		test(`${release}: every gate is ${expected}`, () => {
			expect(runsInObject(release)).toBe(expected)
			expect(pinsGeneratedEntry(release)).toBe(expected)
			expect(servesOps(release)).toBe(expected)
			expect(capsJobSegments(release)).toBe(expected)
			expect(servesAlarms(release)).toBe(expected)
			expect(servesDataOperations(release)).toBe(expected)
			expect(servesRawSql(release)).toBe(expected)
		})
	}

	// Their object runs jobs only from the minute tick, has no alarm and answers `state` and `migrate` 501.
	for (const release of PUBLISHED_PRERELEASES) {
		test(`published ${release} runs in the object with the ops channel, and without alarms, the segment cap, the data operations or raw SQL`, () => {
			expect(runsInObject(release)).toBe(true)
			expect(pinsGeneratedEntry(release)).toBe(true)
			expect(servesOps(release)).toBe(true)
			expect(capsJobSegments(release)).toBe(false)
			expect(servesAlarms(release)).toBe(false)
			expect(servesDataOperations(release)).toBe(false)
			expect(servesRawSql(release)).toBe(false)
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
