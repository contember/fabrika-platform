import { describe, expect, test } from 'bun:test'
import { APP_PROVIDER, authoredAppProvider, isProviderAuthoredApp } from '..'

describe('provider-authored app identity', () => {
	test('reads and narrows a provider tag without a cast', () => {
		const app: unknown = { [APP_PROVIDER]: 'zerops' }
		expect(authoredAppProvider(app)).toBe('zerops')
		expect(isProviderAuthoredApp(app, 'zerops')).toBe(true)
		expect(isProviderAuthoredApp(app, 'cloudflare')).toBe(false)
	})

	test('rejects absent and empty provider tags', () => {
		expect(authoredAppProvider({})).toBeUndefined()
		expect(authoredAppProvider({ [APP_PROVIDER]: '' })).toBeUndefined()
		expect(authoredAppProvider(null)).toBeUndefined()
	})
})
