// The Notes fixture names the framework release the composed container runs, so Control reads it with this release's
// own reader and deploys it (ADR-0062), as the stack's deploy does with the same commit.

import { CHECKER_VERSION } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { readAccessSnapshot } from '../../../control/src/approval/read'
import { applicationFixtureSource } from './generate'

describe('the application fixture', () => {
	test("passes Control's window check of this source version, with this release's reader", async () => {
		const decoder = new TextDecoder()
		const files = new Map([...await applicationFixtureSource()].map(([path, bytes]) => [path, decoder.decode(bytes)]))
		const snapshot = await readAccessSnapshot({ paths: new Set(files.keys()), read: async (path) => files.get(path) ?? '' }, '', 'notes')
		expect(snapshot.framework).toBe(CHECKER_VERSION)
		expect(snapshot.checker).toBe(CHECKER_VERSION)
		expect(snapshot.older).toBeUndefined()
	})
})
