import { assertAppRuntimeConformance } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { operationsApp, type OperationsAppEnv } from '../app'
import { createOperationsIam } from '../auth.js'
import { SqliteHealthRepository } from '../health-repository.js'
import { createHarness } from './helpers/sqlite.js'

const publicHost = 'errors.example.test'

function env(): OperationsAppEnv {
	const harness = createHarness()
	return {
		repositories: harness.repositories,
		publicHost,
		syncKey: 'catalog-sync-key-with-at-least-32-characters',
		ingestQueue: { send: () => Promise.resolve() },
		payloads: {
			put: () => Promise.resolve(),
			get: () => Promise.resolve(null),
			delete: () => Promise.resolve(),
		},
		health: new SqliteHealthRepository(harness.db),
		iam: createOperationsIam({ DEV: 'true', ENVIRONMENT: 'local' }),
	}
}

describe('Operations runtime conformance', () => {
	test('keeps private health behavior identical through every adapter', async () => {
		const response = await assertAppRuntimeConformance({
			app: operationsApp,
			createEnv: env,
			createRequest: () => new Request('https://operations.internal/healthz'),
		})

		expect(response.status).toBe(200)
		expect(response.body).toBe('{"status":"ok"}')
	})

	test('keeps the public-host isolation boundary identical through every adapter', async () => {
		const response = await assertAppRuntimeConformance({
			app: operationsApp,
			createEnv: env,
			createRequest: () => new Request(`https://${publicHost}/healthz`),
		})

		expect(response.status).toBe(404)
		expect(response.body).toBe('{"error":"not found"}')
	})
})
