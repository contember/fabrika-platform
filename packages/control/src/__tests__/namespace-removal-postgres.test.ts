// The namespace removal statements against a REAL Postgres (backlog 73).
//
// They are the reason this file exists: removal is TWO statements in one transaction — claims first,
// because both foreign keys are `ON DELETE RESTRICT`, and both carrying the same guard — and a guard
// expressed as `NOT EXISTS (...)` inside a `DELETE ... RETURNING` is exactly the shape that can behave
// differently on the two dialects. `namespace-removal.test.ts` proves the behaviour on SQLite/D1.
//
// Skips cleanly (with a reason) when FABRIKA_TEST_POSTGRES_URL is unset — see helpers/postgres.ts.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type ControlRepositories, createControlRepositories } from '../db'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) {
	console.warn(`namespace-removal-postgres.test.ts ${skipReason}`)
}

let fixture: PostgresFixture | null = null
let db: ControlRepositories

beforeAll(async () => {
	if (!hasPostgres) return
	fixture = await createPostgres('vozka_ns_remove')
	db = createControlRepositories(fixture.db)
})

afterAll(async () => {
	await fixture?.close()
})

const envelope = (payload: Record<string, string>): string => JSON.stringify({ provider: 'harbor', version: 1, payload })

async function seed(id: string, state: 'pending' | 'provisioning' | 'ready' | 'failed'): Promise<void> {
	await db.registry.createDeploymentNamespaceWithResourceClaims({
		id,
		env: 'prod',
		provider: 'harbor',
		exclusiveAppId: null,
		providerTargetJson: envelope({ projectId: 'project-1' }),
		state,
	}, ['service:proxy'])
}

describe.skipIf(!hasPostgres)('deployment namespace removal on Postgres', () => {
	test('removes the row and its reservations in one transaction', async () => {
		await seed('failed-prod', 'failed')

		const removed = await db.registry.deleteDeploymentNamespaceWithResourceClaims('failed-prod')

		expect(removed?.id).toBe('failed-prod')
		expect(removed?.state).toBe('failed')
		expect(await db.registry.getDeploymentNamespace('failed-prod')).toBeNull()
		expect(await db.registry.listNamespaceResourceClaims('failed-prod')).toEqual([])
		// The id is free again, which is the whole point of removal.
		await seed('failed-prod', 'pending')
		expect((await db.registry.getDeploymentNamespace('failed-prod'))?.state).toBe('pending')
		await db.registry.deleteDeploymentNamespaceWithResourceClaims('failed-prod')
	})

	test('refuses a settling namespace without touching its reservations', async () => {
		await seed('settling-prod', 'provisioning')

		expect(await db.registry.deleteDeploymentNamespaceWithResourceClaims('settling-prod')).toBeNull()
		expect(await db.registry.getDeploymentNamespace('settling-prod')).not.toBeNull()
		expect((await db.registry.listNamespaceResourceClaims('settling-prod')).map((claim) => claim.resource_key)).toEqual(['service:proxy'])
	})

	test('refuses a namespace an app environment is registered in, and keeps every claim', async () => {
		await seed('busy-prod', 'ready')
		await db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes' })
		await db.registry.upsertAppEnvWithNamespaceResourceClaims({
			appId: 'notes',
			env: 'prod',
			namespaceId: 'busy-prod',
			provider: 'harbor',
			providerTargetJson: envelope({ serviceId: 'service-1' }),
			providerArtifactJson: envelope({ image: 'registry.example/notes:v1' }),
		}, ['service:notes'])

		expect(await db.registry.deleteDeploymentNamespaceWithResourceClaims('busy-prod')).toBeNull()
		expect((await db.registry.listNamespaceResourceClaims('busy-prod')).map((claim) => claim.resource_key)).toEqual([
			'service:notes',
			'service:proxy',
		])
	})

	test('answers null for a namespace that is already gone', async () => {
		expect(await db.registry.deleteDeploymentNamespaceWithResourceClaims('never-existed')).toBeNull()
	})
})
