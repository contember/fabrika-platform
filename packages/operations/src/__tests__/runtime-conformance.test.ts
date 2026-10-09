import { assertAppRuntimeConformance } from '@fabrika/app/testing'
import { ENDPOINT_HEADER } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { operationsApp, type OperationsAppEnv } from '../app'
import { SqliteHealthRepository } from '../health-repository.js'
import { testOperationsIam } from './helpers/iam.js'
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
		iam: testOperationsIam(),
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
		expect(response.body).toBe('{"error":{"type":"not_found","message":"Not found"}}')
	})

	test("serves Control's operator gateway hop through every adapter, though it carries the console's endpoint header", async () => {
		const response = await assertAppRuntimeConformance({
			app: operationsApp,
			createEnv: env,
			createRequest: () =>
				new Request('https://operations.internal/api/rpc', {
					method: 'POST',
					// What Control's proxy named for its own `operations-rpc` row; Operations' private row checks no header.
					headers: { 'content-type': 'application/json', [ENDPOINT_HEADER]: `operations-rpc@sha256:${'0'.repeat(64)}` },
					body: JSON.stringify({ method: 'sources', input: null }),
				}),
		})

		// Reached the operator RPC, which refuses a request without the proxy's token: no 404, no 503.
		expect(response.status).toBe(401)
	})
})
