// The namespace update's guarded writes against a REAL Postgres (backlog 79): the transition compares a
// nullable `last_error` through `COALESCE` and computes its state from `repair_requested`, and the requeue
// branches on the mark inside one UPDATE — shapes where the dialects can differ. `namespace-update.test.ts`
// proves the behaviour on SQLite.

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

const MARK = 'namespaceUpdateUnconfirmed: retry namespaces.update with the planned target in unconfirmedTarget'
const PLANNED = '{"phase":"large"}'

describe.skipIf(!hasPostgres)('namespace update writes on Postgres', () => {
	async function seedMarked(id: string): Promise<{ row: DeploymentNamespaceRow; holder: string }> {
		const { registry } = createControlRepositories(fixture.db)
		const created = await registry.createDeploymentNamespace({
			id,
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: '{"phase":"small"}',
			state: 'ready',
		})
		const holder = `holder-${id}`
		expect(await registry.namespaceLocks().acquire(namespaceLeaseKey(id), holder, LEASE_TTL_MS)).toBe(true)
		const mark = () =>
			registry.transitionDeploymentNamespace({
				id,
				createdAt: created.created_at,
				fence: { holder, nowMs: Date.now() },
				from: { state: 'ready', lastError: null },
				to: { state: 'failed', providerTargetJson: created.provider_target_json, lastError: MARK, updateTargetJson: PLANNED },
			})
		const row = await mark()
		if (row === null) throw new Error('the mark did not land')
		// A second mark from the same read does not land.
		expect(await mark()).toBeNull()
		return { row, holder }
	}

	const clear = (row: DeploymentNamespaceRow, holder: string, as: 'someone-else' | 'holder' = 'holder') =>
		createControlRepositories(fixture.db).registry.transitionDeploymentNamespace({
			id: row.id,
			createdAt: row.created_at,
			fence: { holder: as === 'holder' ? holder : 'someone-else', nowMs: Date.now() },
			from: { state: 'failed', lastError: MARK },
			to: { state: 'ready', providerTargetJson: PLANNED, lastError: null, updateTargetJson: null },
		})

	test('the mark carries the planned target, and removal and a write without the lease leave it alone', async () => {
		const { registry } = createControlRepositories(fixture.db)
		const { row, holder } = await seedMarked('guarded')
		expect(row).toMatchObject({ state: 'failed', last_error: MARK, update_target_json: PLANNED, repair_requested: 0 })

		expect(await clear(row, holder, 'someone-else')).toBeNull()
		expect(await registry.deleteDeploymentNamespaceWithResourceClaims(row.id)).toBeNull()
		expect(await registry.getDeploymentNamespace(row.id)).toEqual(row)

		const stored = await clear(row, holder)
		expect(stored).toMatchObject({ state: 'ready', provider_target_json: PLANNED, last_error: null, update_target_json: null })
		// Once the mark is gone the ordinary requeue applies again.
		expect((await registry.requeueDeploymentNamespace(row.id))?.state).toBe('pending')
	})

	test('a requeue of a marked row records the repair, and the clearing write lands pending for it', async () => {
		const { registry } = createControlRepositories(fixture.db)
		const { row, holder } = await seedMarked('replayed')

		const recorded = await registry.requeueDeploymentNamespace(row.id)
		expect(recorded).toMatchObject({ state: 'failed', last_error: MARK, update_target_json: PLANNED, repair_requested: 1 })

		const stored = await clear(row, holder)
		expect(stored).toMatchObject({ state: 'pending', provider_target_json: PLANNED, update_target_json: null, repair_requested: 0 })
	})

	test('requeue still takes a row that failed for any other reason', async () => {
		const { registry } = createControlRepositories(fixture.db)
		const created = await registry.createDeploymentNamespace({
			id: 'other-failure',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			providerTargetJson: '{}',
			state: 'failed',
			lastError: 'insufficientPermissions: denied',
		})

		expect(await registry.requeueDeploymentNamespace(created.id)).toMatchObject({ state: 'pending', last_error: null, repair_requested: 0 })
	})
})
