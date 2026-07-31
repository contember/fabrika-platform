import { describe, expect, test } from 'bun:test'
import { controlApp } from '../app'
import type { Env } from '../env'
import { createHarness } from './helpers/harness'
import { fakeControlProvider } from './helpers/provider'

function application() {
	const harness = createHarness()
	const env: Env = {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response('dashboard')) },
		RUN_LOGS: {
			put: () => Promise.resolve(),
			get: () => Promise.resolve(null),
			delete: () => Promise.resolve(),
		},
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		ENVIRONMENT: 'local',
		DEV: 'true',
	}
	return (request: Request) =>
		controlApp.fetch(request, { env, provider: fakeControlProvider }, {
			waitUntil() {},
		})
}

describe('controlApp', () => {
	test('keeps liveness public and serves the SPA fallback', async () => {
		const fetch = application()

		expect((await fetch(new Request('https://control.test/healthz'))).status).toBe(200)
		expect((await fetch(new Request('https://control.test/healthz', { method: 'HEAD' }))).status).toBe(200)
		expect((await fetch(new Request('https://control.test/api/health', { method: 'POST' }))).status).toBe(200)
		expect(await (await fetch(new Request('https://control.test/apps/example'))).text()).toBe('dashboard')
	})

	test('uses the IAM SDK middleware and its dev persona header', async () => {
		const fetch = application()
		const viewer = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { 'X-Dev-Principal': 'viewer@vozka.test' },
			}),
		)
		const admin = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { 'X-Dev-Principal': 'admin@vozka.test' },
			}),
		)
		const unknown = await fetch(
			new Request('https://control.test/api/apps', {
				headers: { 'X-Dev-Principal': 'missing@vozka.test' },
			}),
		)

		expect(viewer.status).toBe(403)
		expect(admin.status).toBe(200)
		expect(unknown.status).toBe(403)
	})
})
