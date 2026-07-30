import {
	FABRIKA_APP_ID,
	FABRIKA_ENVIRONMENT,
	FABRIKA_OPERATIONS_DSN,
	FABRIKA_SERVICE_KEY,
	operationsEnvelopeUrl,
	operationsManagedEnvironmentCollisions,
} from '@fabrika/operations-contract/ingest'
import { describe, expect, test } from 'bun:test'
import { generateIngestProjectId, generateIngestPublicKey, provisionSourceIngest, rotateSourceIngestCredential } from '../credentials.js'
import { credentialVerifier } from '../pipeline.js'
import { createHarness } from './helpers/sqlite.js'

const KEY_ONE = '0123456789abcdef0123456789abcdef'
const KEY_TWO = 'abcdef0123456789abcdef0123456789'
const PROJECT_ID = '123456789012345678'

async function addSource(harness: ReturnType<typeof createHarness>): Promise<void> {
	await harness.repositories.sources.upsert({
		id: '0198-source-uuid',
		appId: 'notes',
		environment: 'production',
		serviceKey: 'api',
		displayName: 'Notes API',
		enabled: true,
	})
}

describe('Operations ingest credential lifecycle', () => {
	test('creates an SDK-shaped DSN while persisting only the verifier', async () => {
		const harness = createHarness(() => 1_000)
		await addSource(harness)
		const issued = await provisionSourceIngest(
			harness.repositories,
			{ sourceId: '0198-source-uuid', operationsOrigin: 'https://operations.example.test' },
			{ now: () => 1_000, publicKey: () => KEY_ONE, ingestProjectId: () => PROJECT_ID },
		)

		expect(issued.ingestProjectId).toBe(PROJECT_ID)
		expect(issued.ingestProjectId).not.toBe('0198-source-uuid')
		expect(issued.dsn).toBe(`https://${KEY_ONE}@operations.example.test/${PROJECT_ID}`)
		expect(issued.managedEnvironment).toEqual({
			[FABRIKA_OPERATIONS_DSN]: issued.dsn,
			[FABRIKA_APP_ID]: 'notes',
			[FABRIKA_ENVIRONMENT]: 'production',
			[FABRIKA_SERVICE_KEY]: 'api',
		})

		// This mirrors the public Sentry SDK DSN derivation: <dsn>/api/<numeric project>/envelope/.
		const dsn = new URL(issued.dsn)
		expect(dsn.username).toBe(KEY_ONE)
		expect(dsn.pathname).toBe(`/${PROJECT_ID}`)
		expect(operationsEnvelopeUrl(dsn.origin, PROJECT_ID)).toBe(`https://operations.example.test/api/${PROJECT_ID}/envelope/`)

		const persisted = JSON.stringify(harness.sqlite.query('SELECT * FROM ingest_credentials').all())
		expect(persisted).not.toContain(KEY_ONE)
		expect(persisted).toContain(await credentialVerifier(KEY_ONE))
		expect((await harness.repositories.sources.get('0198-source-uuid'))?.ingest_project_id).toBe(PROJECT_ID)
	})

	test('rotates in two phases and keeps the old key only through the overlap', async () => {
		let now = 1_000
		const harness = createHarness(() => now)
		await addSource(harness)
		await provisionSourceIngest(
			harness.repositories,
			{ sourceId: '0198-source-uuid', operationsOrigin: 'https://operations.example.test' },
			{ now: () => now, publicKey: () => KEY_ONE, ingestProjectId: () => PROJECT_ID },
		)

		now = 2_000
		const replacement = await rotateSourceIngestCredential(
			harness.repositories,
			{ sourceId: '0198-source-uuid', operationsOrigin: 'https://operations.example.test' },
			{ now: () => now, publicKey: () => KEY_TWO, ingestProjectId: () => '999', overlapMs: 500 },
		)
		expect(replacement.ingestProjectId).toBe(PROJECT_ID)
		expect((await harness.repositories.sources.resolveIngestCredential(await credentialVerifier(KEY_ONE), 2_499))?.sourceId).toBe(
			'0198-source-uuid',
		)
		expect(await harness.repositories.sources.resolveIngestCredential(await credentialVerifier(KEY_ONE), 2_500)).toBeNull()
		expect((await harness.repositories.sources.resolveIngestCredential(await credentialVerifier(KEY_TWO), 10_000))?.ingestProjectId).toBe(
			PROJECT_ID,
		)
		expect(await harness.repositories.sources.revokeSourceCredential('other-source', replacement.id)).toBe(false)
		expect(await harness.repositories.sources.revokeSourceCredential('0198-source-uuid', replacement.id)).toBe(true)
		expect(await harness.repositories.sources.resolveIngestCredential(await credentialVerifier(KEY_TWO), 2_501)).toBeNull()
	})

	test('publishes reserved-key collision detection and valid random credential shapes', () => {
		expect(operationsManagedEnvironmentCollisions(['USER_VALUE', FABRIKA_OPERATIONS_DSN, FABRIKA_APP_ID])).toEqual([
			FABRIKA_OPERATIONS_DSN,
			FABRIKA_APP_ID,
		])
		expect(generateIngestPublicKey()).toMatch(/^[0-9a-f]{32}$/)
		expect(generateIngestProjectId()).toMatch(/^[1-9][0-9]{17}$/)
	})
})
