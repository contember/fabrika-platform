// ADR-0062: which reader reads an application, by the framework release its `bun.lock` pins, and the one line that
// refuses a release outside the window. The artifact formats: each parsed by its own schema and upcast.

import { CONTRACT_FORMAT } from '@fabrika/auth-core'
import { CHECKER_VERSION } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { parseStoredArtifact } from '../approval/formats'
import { readAccessSnapshot } from '../approval/read'
import { type ContractReader, FrameworkReleaseRefused, MIGRATION_GUIDE, readerFor, type ReaderWindow } from '../approval/readers'
import { frameworkLockfile, memoryCommits } from './helpers/commits'
import { healthOnly } from './helpers/contracts'

const reader = (checker: string): ContractReader => ({ checker, inputs: () => [], read: () => ({ ok: false, problems: 1 }) })

/** A platform on 0.7.0 that bundles the 0.5 reader and, past the window's rule, not the 0.6 one. */
const WINDOW: ReaderWindow = { platform: '0.7.0', readers: [reader('0.7.0'), reader('0.5.4')] }

const refusal = (release: string, window?: ReaderWindow): string => {
	try {
		readerFor(release, window)
	} catch (error) {
		if (error instanceof FrameworkReleaseRefused) return error.message
		throw error
	}
	throw new Error(`${release} was not refused`)
}

describe('the reader of a framework release', () => {
	test("is the one of the release's minor, any patch of it", () => {
		expect(readerFor('0.7.0', WINDOW).checker).toBe('0.7.0')
		expect(readerFor('0.7.0-next.2', WINDOW).checker).toBe('0.7.0')
		expect(readerFor('0.5.0', WINDOW).checker).toBe('0.5.4')
		expect(readerFor('0.5.9', WINDOW).checker).toBe('0.5.4')
	})

	test("is this platform's own for its own release, and the bundled newest patch for 0.5 and 0.4", () => {
		expect(readerFor(CHECKER_VERSION).checker).toBe(CHECKER_VERSION)
		expect(readerFor('0.5.1').checker).toBe('0.5.5')
		expect(readerFor('0.4.1').checker).toBe('0.4.8')
	})

	test('this platform refuses 0.3, below its window of 0.4, 0.5 and its own minor', () => {
		expect(refusal('0.3.9')).toContain('the oldest release it deploys is 0.4.0')
	})

	test('a release outside the window is refused with the oldest release the platform deploys and the migration guide', () => {
		const line =
			`the application pins @fabrika/app 0.4.2, outside this platform's window; the oldest release it deploys is 0.5.0. Raise the pin as ${MIGRATION_GUIDE} describes`
		expect(refusal('0.4.2', WINDOW)).toBe(line)
		expect(refusal('0.6.3', WINDOW)).toContain("the application pins @fabrika/app 0.6.3, outside this platform's window")
	})

	test('a release newer than the platform is refused, a newer patch too: the platform is upgraded first', () => {
		expect(refusal('0.7.1', WINDOW)).toBe("the application pins @fabrika/app 0.7.1, newer than this platform's 0.7.0; upgrade the platform first")
		expect(refusal('1.0.0', WINDOW)).toBe("the application pins @fabrika/app 1.0.0, newer than this platform's 0.7.0; upgrade the platform first")
	})
})

describe("the framework release of an application's commit", () => {
	const snapshotOf = async (tree: Record<string, string | null>) =>
		readAccessSnapshot(
			await memoryCommits({ 'fabrika.contract.ts': healthOnly('notes'), ...tree }).open({
				repoUrl: 'github.com/acme/notes',
				commitSha: 'c'.repeat(40),
				signal: new AbortController().signal,
			}),
			'',
			'notes',
		)
	const refused = async (tree: Record<string, string | null>): Promise<string> => {
		try {
			await snapshotOf(tree)
		} catch (error) {
			if (error instanceof FrameworkReleaseRefused) return error.message
			throw error
		}
		throw new Error('the commit was not refused')
	}

	test('is the registry release its bun.lock resolves, which the snapshot records with the reader', async () => {
		const snapshot = await snapshotOf({ 'bun.lock': frameworkLockfile('0.5.3') })
		expect(snapshot.framework).toBe('0.5.3')
		expect(snapshot.checker).toBe('0.5.5')
	})

	test('a commit without a bun.lock at the application root is refused, and another lockfile is named', async () => {
		expect(await refused({ 'bun.lock': null })).toBe(
			'the application root has no bun.lock, which names its @fabrika/app release; commit the bun.lock that `bun install` writes',
		)
		expect(await refused({ 'bun.lock': null, 'bun.lockb': 'binary' })).toBe(
			'the application root has no bun.lock, which names its @fabrika/app release; it has bun.lockb, which Control does not read; run `bun install --save-text-lockfile` and commit bun.lock',
		)
		expect(await refused({ 'bun.lock': null, 'package-lock.json': '{}' })).toContain('it has package-lock.json; an application installs with bun')
	})

	test('a bun.lock that resolves no registry release of @fabrika/app is refused', async () => {
		const workspace = JSON.stringify({ lockfileVersion: 1, packages: { '@fabrika/app': ['@fabrika/app@workspace:packages/app'] } })
		expect(await refused({ 'bun.lock': workspace })).toBe('bun.lock resolves no npm registry release of @fabrika/app')
		expect(await refused({ 'bun.lock': '{}' })).toBe('bun.lock resolves no npm registry release of @fabrika/app')
	})
})

describe('a stored artifact', () => {
	test('of this release keeps its model and has no older artifact', () => {
		expect(parseStoredArtifact(JSON.parse(JSON.stringify(notesArtifact)))).toEqual({ contract: notesArtifact })
	})

	test('without a format is the 0.5 one: kept as read, and upcast to this release', () => {
		const { format: _format, ...older } = notesArtifact
		const parsed = parseStoredArtifact(JSON.parse(JSON.stringify(older)))
		expect<unknown>(parsed.older).toEqual(older)
		expect(parsed.contract.format).toBe(CONTRACT_FORMAT)
	})

	test('of a format outside the window is refused', () => {
		expect(() => parseStoredArtifact({ ...notesArtifact, format: CONTRACT_FORMAT + 1 })).toThrow()
	})
})
