import { assertAppRuntimeConformance } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { controlApp } from '../app'
import type { Env } from '../env'
import { createHarness } from './helpers/harness'
import { fakeControlProvider } from './helpers/provider'

function env(): Env {
	const harness = createHarness()
	return {
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
}

describe('Delivery runtime conformance', () => {
	test('keeps public liveness identical through every adapter', async () => {
		const response = await assertAppRuntimeConformance({
			app: controlApp,
			createEnv: () => ({ env: env(), provider: fakeControlProvider }),
			createRequest: () => new Request('https://control.test/healthz'),
		})

		expect(response.status).toBe(200)
		expect(response.body).toBe('{"status":"ok"}')
	})

	test('keeps SPA fallback behavior identical through every adapter', async () => {
		const response = await assertAppRuntimeConformance({
			app: controlApp,
			createEnv: () => ({ env: env(), provider: fakeControlProvider }),
			createRequest: () => new Request('https://control.test/apps/example'),
		})

		expect(response.status).toBe(200)
		expect(response.body).toBe('dashboard')
	})
})
