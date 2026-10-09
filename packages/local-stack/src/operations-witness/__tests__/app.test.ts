import { createBunHandler } from '@fabrika/app/bun'
import { PROXY_SECRET_HEADER, PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { witnessApp } from '../app'

const fixture = { dsn: 'https://0123456789abcdef0123456789abcdef@operations.test/123', release: 'release-123', script: 'console.info("SDK fixture")' }

const SECRET = 'witness-proxy-secret'
const handler = createBunHandler(witnessApp, { verified: (token) => Promise.resolve(token === 'valid'), proxySecret: SECRET, fixture }, {
	onBackgroundError: () => undefined,
})
const get = (path: string, token?: string, secret = SECRET) =>
	handler.fetch(
		new Request(`http://sdk.test${path}`, {
			headers: { [PROXY_SECRET_HEADER]: secret, ...(token === undefined ? {} : { [PROXY_TOKEN_HEADER]: token }) },
		}),
	)

describe('the Operations SDK witness', () => {
	test('answers nothing but its health check without a token that verifies', async () => {
		expect((await get('/healthz')).status).toBe(200)
		for (const path of ['/', '/operations-sdk', '/operations-sdk/config', '/operations-sdk.js']) {
			expect((await get(path)).status).toBe(401)
			expect((await get(path, 'forged')).status).toBe(401)
			// A valid token that did not come through the proxy's hop.
			expect((await get(path, 'valid', 'another-secret')).status).toBe(401)
		}
	})

	test('exposes only the managed DSN and release, through the config response and never in its HTML', async () => {
		const page = await get('/operations-sdk', 'valid')
		expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
		const html = await page.text()
		expect(html).toContain('Capture managed error')
		expect(html).not.toContain(fixture.dsn)
		expect(html).not.toContain(fixture.release)
		expect(await (await get('/operations-sdk/config', 'valid')).json()).toEqual({ dsn: fixture.dsn, release: fixture.release })
		expect(await (await get('/operations-sdk.js', 'valid')).text()).toBe(fixture.script)
	})
})
