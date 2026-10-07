import { describe, expect, test } from 'bun:test'
import { formProvider, providerRegistrationPayload } from '../lib/provider-registration'

const fields = {
	configPath: ' apps/web/fabrika.config.ts ',
	manifest: '{"manifestVersion":3,"app":{"id":"notes"}}',
	namespaceId: 'apps-prod',
}

describe('provider registration payload', () => {
	test('narrows only the providers the console has a form for', () => {
		expect(formProvider('cloudflare')).toBe('cloudflare')
		expect(formProvider('zerops')).toBe('zerops')
		expect(formProvider('harbor')).toBeNull()
	})

	test('builds a Cloudflare config-path artifact with no placement, ignoring the manifest', () => {
		expect(providerRegistrationPayload('cloudflare', { ...fields, manifest: 'not json' })).toEqual({
			namespaceId: null,
			target: { provider: 'cloudflare', version: 1, payload: {} },
			artifact: { provider: 'cloudflare', version: 1, payload: { configPath: 'apps/web/fabrika.config.ts' } },
		})
	})

	test('builds a Zerops manifest artifact in the chosen namespace at the manifest version', () => {
		expect(providerRegistrationPayload('zerops', fields)).toEqual({
			namespaceId: 'apps-prod',
			target: { provider: 'zerops', version: 3, payload: {} },
			artifact: { provider: 'zerops', version: 3, payload: { manifestVersion: 3, app: { id: 'notes' } } },
		})
	})

	test('refuses a Zerops registration without a valid manifest', () => {
		expect(() => providerRegistrationPayload('zerops', { ...fields, manifest: '{' })).toThrow('Paste a valid fabrika.manifest.json.')
	})
})
