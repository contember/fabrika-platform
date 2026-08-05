/**
 * The apps the local stack registers with IAM must be the apps its proxies actually front, at the
 * addresses those proxies are actually reached at.
 *
 * Since ADR-0023 a mismatch is not cosmetic: IAM issues a handoff code only for a REGISTERED return
 * address, so a manifest host and a registered origin that drift apart produce a 400 at sign-in and
 * nothing else. Nothing in the composition would notice until a human tried to log in.
 */

import { describe, expect, test } from 'bun:test'
import { localApps } from '../app-registration'
import { localPlatformProxyManifest } from '../prepare'

/** `http://host:18080` → `host`, the form a proxy manifest lists. */
const hostOf = (origin: string): string => new URL(origin).hostname

describe('the locally registered apps', () => {
	test('vozka is registered at the host the platform proxy fronts it on', () => {
		const vozka = localApps.find((app) => app.id === 'vozka')
		expect(vozka).toBeDefined()
		const fronted = localPlatformProxyManifest().apps.find((app) => app.id === 'vozka')
		expect(vozka?.returnOrigins.map(hostOf)).toEqual(fronted?.hosts ?? [])
	})

	test('every registered app declares at least one origin, because an empty set is a caller error', () => {
		for (const app of localApps) {
			expect(app.returnOrigins.length).toBeGreaterThan(0)
			for (const origin of app.returnOrigins) {
				expect(new URL(origin).origin).toBe(origin)
			}
		}
	})

	test('every registered app declares a non-empty schema, which is what registers it at all', () => {
		for (const app of localApps) {
			expect(app.schema.actions.length).toBeGreaterThan(0)
		}
	})
})
