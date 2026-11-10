// A publish floor names the first framework release that enforces its fields. The source version names the last
// release cut, so a floor is that release or an earlier one, or, while its enforcement is unreleased, the very next
// prerelease of it. A bump that cut the enforcing release under another name would leave the floor above every release
// that enforces it, and this fails then.

import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { RELATION_GRANTS_SINCE, RELATION_WHEN_SINCE } from '../approval/enforcement'
import { comparePrecedence, parseRelease, type Release } from '../approval/readers'

const FLOORS: readonly Release[] = [RELATION_GRANTS_SINCE, RELATION_WHEN_SINCE]

async function sourceVersion(): Promise<Release> {
	const manifest = z.object({ version: z.string() }).parse(await Bun.file(new URL('../../../app/package.json', import.meta.url)).json())
	const release = parseRelease(manifest.version)
	if (release === null) throw new Error(`the framework's source version ${manifest.version} is not a release`)
	return release
}

/** `0.9.0-dev.13` → `0.9.0-dev.14`; null for a release without a numbered prerelease. */
function nextPrerelease(release: Release): string | null {
	const match = /^(\d+\.\d+\.\d+-[0-9A-Za-z-]+\.)(\d+)$/.exec(release.text)
	return match === null ? null : `${match[1]}${Number(match[2]) + 1}`
}

describe('a publish floor', () => {
	for (const floor of FLOORS) {
		test(`${floor.text} is the source version, an earlier release, or the next prerelease`, async () => {
			const source = await sourceVersion()
			if (comparePrecedence(floor, source) <= 0) return
			expect(floor.text).toBe(nextPrerelease(source) ?? source.text)
		})
	}

	test('the next prerelease counts up its last identifier only', () => {
		expect(nextPrerelease({ text: '0.9.0-dev.13', major: 0, minor: 9, patch: 0 })).toBe('0.9.0-dev.14')
		expect(nextPrerelease({ text: '0.9.0', major: 0, minor: 9, patch: 0 })).toBeNull()
	})
})
