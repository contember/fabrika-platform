// The namespace update's guarded writes against a REAL Postgres (backlog 79): the transition compares a
// nullable `last_error` through `COALESCE`, and the mark guard is a `LIKE` inside `NOT (...)` — both
// shapes where the dialects can differ. `namespace-update.test.ts` proves the behaviour on SQLite.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createControlRepositories, type DeploymentNamespaceRow } from '../db'
import { LEASE_TTL_MS, namespaceLeaseKey } from '../lease'
import { createPostgres, hasPostgres, type PostgresFixture, skipReason } from './helpers/postgres'

if (!hasPostgres) console.warn(`namespace-update-postgres.test.ts ${skipReason}`)
let fixture: PostgresFixture
beforeAll(async () => {
	if (hasPostgres) fixture = await createPostgres('namespace_update')
})
afterAll(async () => {
	if (hasPostgres) await fixture.close()
})

const MARK = 'namespaceUpdateUnconfirmed: retry namespaces.update with the same target'

describe.skipIf(!hasPostgres)('namespace update writes on Postgres', () => {
	async function seed(id: string): Promise<{ row: DeploymentNamespaceRow; holder: string }> {
		const { registry } = createControlRepositories(fixture.db)
		const row = await registry.createDeploymentNamespace({
			id,
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: '{"phase":"small"}',
			state: 'ready',
		})
		const holder = `holder-${id}`
		expect(await registry.namespaceLocks().acquire(namespaceLeaseKey(id), holder, LEASE_TTL_MS)).toBe(true)
		return { row, holder }
	}

	test('marks a ready row with a NULL error once, and a second mark from the same read does not land', async () => {
		const { registry } = createControlRepositories(fixture.db)
		const { row, holder } = await seed('mark-once')
		const mark = () =>
			registry.transitionDeploymentNamespace({
				id: row.id,
				createdAt: row.created_at,
				fence: { holder, nowMs: Date.now() },
				from: { state: 'ready', lastError: null },
				to: { state: 'failed', providerTargetJson: row.provider_target_json, lastError: MARK },
			})

		expect(await mark()).toMatchObject({ state: 'failed', last_error: MARK })
		expect(await mark()).toBeNull()
	})

	test('a write without the lease is refused, and requeue and removal leave a marked row alone', async () => {
		const { registry } = createControlRepositories(fixture.db)
		const { row, holder } = await seed('guarded')
		const marked = await registry.transitionDeploymentNamespace({
			id: row.id,
			createdAt: row.created_at,
			fence: { holder, nowMs: Date.now() },
			from: { state: 'ready', lastError: null },
			to: { state: 'failed', providerTargetJson: row.provider_target_json, lastError: MARK },
		})
		if (marked === null) throw new Error('the mark did not land')

		expect(
			await registry.transitionDeploymentNamespace({
				id: row.id,
				createdAt: row.created_at,
				fence: { holder: 'someone-else', nowMs: Date.now() },
				from: { state: 'failed', lastError: MARK },
				to: { state: 'ready', providerTargetJson: '{"phase":"stale"}', lastError: null },
			}),
		).toBeNull()
		expect(await registry.requeueDeploymentNamespace(row.id)).toBeNull()
		expect(await registry.deleteDeploymentNamespaceWithResourceClaims(row.id)).toBeNull()
		expect(await registry.getDeploymentNamespace(row.id)).toEqual(marked)

		const stored = await registry.transitionDeploymentNamespace({
			id: row.id,
			createdAt: row.created_at,
			fence: { holder, nowMs: Date.now() },
			from: { state: 'failed', lastError: MARK },
			to: { state: 'ready', providerTargetJson: '{"phase":"large"}', lastError: null },
		})
		expect(stored).toMatchObject({ state: 'ready', provider_target_json: '{"phase":"large"}', last_error: null })
		// Once the mark is gone the ordinary guards apply again.
		expect((await registry.requeueDeploymentNamespace(row.id))?.state).toBe('pending')
	})

	test('requeue still takes a row that failed for any other reason', async () => {
		const { registry } = createControlRepositories(fixture.db)
		const { row, holder } = await seed('other-failure')
		await registry.transitionDeploymentNamespace({
			id: row.id,
			createdAt: row.created_at,
			fence: { holder, nowMs: Date.now() },
			from: { state: 'ready', lastError: null },
			to: { state: 'failed', providerTargetJson: row.provider_target_json, lastError: 'insufficientPermissions: denied' },
		})

		expect((await registry.requeueDeploymentNamespace(row.id))?.state).toBe('pending')
	})
})
