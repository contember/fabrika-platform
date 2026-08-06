/**
 * The local composition and a deployed installation must be ONE document with two placements.
 *
 * They used to be two: `prepare.ts` built the local manifest and the live one on `fabrika-test` was
 * hand-written, so `CONTROL_PROXY_GATES` could change and reach only one of them — which is what
 * happened, and what nothing reported (backlog 58). `prepare.ts` now calls the installation's
 * generator, and this file pins the consequence: everything except the hostnames, the scheme and IAM's
 * port is identical on both sides, so a gate change cannot reach one and miss the other.
 */

import { describe, expect, test } from 'bun:test'
import { PLATFORM_PROXY_APPS, platformProxyManifestTemplate } from '../../../installation-zerops/zerops/proxy-manifest'
import { localApps } from '../app-registration'
import { localPlatformProxyManifest } from '../prepare'

describe('the local platform manifest is the installation template, placed locally', () => {
	test('the same apps in the same order, with the same gates', () => {
		const local = localPlatformProxyManifest().apps
		expect(local.map((app) => app.id)).toEqual(PLATFORM_PROXY_APPS.map((app) => app.id))
		expect(local.map((app) => app.gates)).toEqual(PLATFORM_PROXY_APPS.map((app) => app.gates))
	})

	test('and nothing beside them — an app the local stack alone fronts would be a definition of its own', () => {
		expect(localPlatformProxyManifest().apps).toHaveLength(platformProxyManifestTemplate().apps.length)
	})

	test('only the composition-owned fields differ: every host is local and every scheme is plain HTTP', () => {
		for (const app of localPlatformProxyManifest().apps) {
			expect(app.scheme).toBe('http')
			expect(app.hosts.every((host) => host.endsWith('.fabrika.localhost'))).toBe(true)
		}
	})

	test('the upstreams are the installation ones except IAM, which the composition publishes on 18080', () => {
		const byId = new Map(localPlatformProxyManifest().apps.map((app) => [app.id, app.upstream]))
		for (const app of PLATFORM_PROXY_APPS) {
			const expected = app.service === 'iam' ? 'iam:18080' : app.upstream
			expect(byId.get(app.id)).toBe(expected)
		}
	})
})

describe('what the local composition registers with IAM', () => {
	test('every registered app is one the platform proxy fronts, at a host it fronts it on', () => {
		const fronted = new Map(localPlatformProxyManifest().apps.map((app) => [app.id, app.hosts]))
		for (const app of localApps) {
			const hosts = fronted.get(app.id)
			// `notes` is fronted by the OTHER local proxy, so absence here is not a failure; a registered
			// origin that names a host the platform proxy does NOT serve would be.
			if (hosts === undefined) continue
			expect(app.returnOrigins.map((origin) => new URL(origin).hostname)).toEqual(hosts)
		}
	})
})
