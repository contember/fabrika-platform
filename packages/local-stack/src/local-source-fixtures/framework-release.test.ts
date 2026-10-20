// The Notes fixture names the framework release the composed container runs, so Control reads it with this release's
// own reader and deploys it (ADR-0062), as the stack's deploy does with the same commit. Each release fixture names the
// release its tag pins, so Control reads it with the bundled reader of that minor (`local:compat`).

import { CHECKER_VERSION } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { readAccessSnapshot } from '../../../control/src/approval/read'
import { LOCAL_SOURCE_RELEASE_KINDS, LOCAL_SOURCE_RELEASE_TAGS } from '../local-source-contract'
import { applicationFixtureSource, releaseFixtureSource } from './generate'

const read = async (source: ReadonlyMap<string, Uint8Array<ArrayBuffer>>) => {
	const decoder = new TextDecoder()
	const files = new Map([...source].map(([path, bytes]) => [path, decoder.decode(bytes)]))
	return readAccessSnapshot({ paths: new Set(files.keys()), read: async (path) => files.get(path) ?? '' }, '', 'notes')
}

describe('the application fixture', () => {
	test("passes Control's window check of this source version, with this release's reader", async () => {
		const snapshot = await read(await applicationFixtureSource())
		expect(snapshot.framework).toBe(CHECKER_VERSION)
		expect(snapshot.checker).toBe(CHECKER_VERSION)
		expect(snapshot.older).toBeUndefined()
	})

	for (const kind of LOCAL_SOURCE_RELEASE_KINDS) {
		const release = LOCAL_SOURCE_RELEASE_TAGS[kind].slice(1)
		test(`at ${release} is read by the bundled reader of its minor`, async () => {
			const snapshot = await read(await releaseFixtureSource(kind))
			expect(snapshot.framework).toBe(release)
			expect(snapshot.checker).toBe(release)
		})
	}
})
