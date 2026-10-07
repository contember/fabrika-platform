import { describe, expect, test } from 'bun:test'
import { parseBrowserFixtures, parseBrowserIdentity } from '../browser-fixture-schemas'

describe('browser fixture parsing', () => {
	test('keeps identity bytes and names the missing or invalid field', () => {
		const roles: ('admin' | 'operations-notes')[] = ['admin', 'operations-notes']
		for (const role of roles) {
			const identity = { role, principalId: 'principal', label: 'Browser user', session: 'opaque-session', expiresAt: 123 }
			expect(parseBrowserIdentity({ ...identity, extension: true })).toEqual(identity)
		}
		expect(() => parseBrowserIdentity({ role: 'other' })).toThrow('browser identity has an invalid role')
		expect(() => parseBrowserIdentity({ role: '' })).toThrow('browser fixture is missing role')
		expect(() => parseBrowserIdentity({ role: 'admin', principalId: '' })).toThrow('browser fixture is missing principalId')
	})

	test('refuses an unsupported fixture version and names a missing release field', () => {
		const visible = {
			appId: 'browser-notes',
			environment: 'test',
			serviceKey: 'default',
			displayName: 'Browser Notes / test',
			credentialId: 'credential',
			publicKey: 'key',
			ingestProjectId: '123',
			release: { name: 'release', runId: 'run', uploadBearer: 'opaque-bearer' },
		}
		const hidden = { ...visible, appId: 'browser-hidden', environment: 'secret' }
		expect(parseBrowserFixtures({ version: 1, visible: { ...visible, nextRelease: {} }, hidden })).toEqual({ version: 1, visible, hidden })
		expect(() => parseBrowserFixtures({ version: 2, visible, hidden })).toThrow('unsupported version')
		expect(() => parseBrowserFixtures({ version: 1, visible: { ...visible, release: {} }, hidden })).toThrow('browser fixture is missing name')
	})
})
