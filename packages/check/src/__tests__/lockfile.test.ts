import { describe, expect, test } from 'bun:test'
import { lockedRegistryVersion } from '../lockfile'

const lockfile = (packages: Record<string, unknown>): string =>
	`{\n  "lockfileVersion": 1,\n  "workspaces": { "": { "name": "app" } },\n  "packages": ${JSON.stringify(packages)},\n}\n`

describe('lockedRegistryVersion', () => {
	test("is the registry version of the application's own entry, in the trailing-comma form bun writes", () => {
		expect(lockedRegistryVersion(lockfile({ '@fabrika/app': ['@fabrika/app@0.5.4', '', {}, 'sha512-AAAA'] }), '@fabrika/app')).toBe('0.5.4')
		expect(lockedRegistryVersion(lockfile({ '@fabrika/app': ['@fabrika/app@0.6.0-next.1', '', {}, 'sha512-AAAA'] }), '@fabrika/app')).toBe(
			'0.6.0-next.1',
		)
	})

	test('is null for an entry that does not resolve from the npm registry', () => {
		const resolved = (resolution: string, registry: unknown) => lockfile({ '@fabrika/app': [resolution, registry, {}, 'sha512-AAAA'] })
		expect(lockedRegistryVersion(resolved('@fabrika/app@workspace:packages/app', ''), '@fabrika/app')).toBeNull()
		expect(lockedRegistryVersion(resolved('@fabrika/app@vendor/fabrika-app-0.5.4.tgz', ''), '@fabrika/app')).toBeNull()
		expect(lockedRegistryVersion(resolved('@fabrika/app@0.5.4', 'https://registry.example.test/'), '@fabrika/app')).toBeNull()
		expect(lockedRegistryVersion(resolved('@fabrika/other@0.5.4', ''), '@fabrika/app')).toBeNull()
	})

	test('is null when only another package depends on it, or there is no lockfile', () => {
		expect(lockedRegistryVersion(lockfile({ 'dep/@fabrika/app': ['@fabrika/app@0.5.4', '', {}, 'sha512-AAAA'] }), '@fabrika/app')).toBeNull()
		expect(lockedRegistryVersion('not json', '@fabrika/app')).toBeNull()
		expect(lockedRegistryVersion('{ "lockfileVersion": 1 }', '@fabrika/app')).toBeNull()
	})
})
