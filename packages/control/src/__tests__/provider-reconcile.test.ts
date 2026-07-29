import type { ControlProvider, ProviderReconcileOutcome } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { reconcileProviderRuns } from '../provider-reconcile'
import { createHarness } from './helpers/harness'
import { providerEnvironment, TEST_PROVIDER_ID } from './helpers/provider'

function provider(outcomes: Readonly<Record<string, ProviderReconcileOutcome>>, environments: string[]): ControlProvider {
	return {
		id: TEST_PROVIDER_ID,
		normalizeRegistration: (input) => input,
		deploy: () => Promise.resolve({ state: 'succeeded' }),
		reconcile: (input) => {
			environments.push(`${input.environment.target.provider}:${JSON.stringify(input.environment.target.payload)}`)
			const outcome = outcomes[input.externalId]
			if (outcome === undefined) {
				return Promise.reject(new Error(`unexpected external run ${input.externalId}`))
			}
			return Promise.resolve(outcome)
		},
	}
}

describe('reconcileProviderRuns', () => {
	test('finishes terminal operations through a third provider and leaves pending work untouched', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.upsertAppEnv(providerEnvironment('app', 'prod'))
		await db.upsertAppEnv({
			appId: 'app',
			env: 'foreign',
			provider: 'other',
			providerTargetJson: JSON.stringify({ provider: 'other', version: 1, payload: {} }),
			providerArtifactJson: JSON.stringify({ provider: 'other', version: 1, payload: {} }),
		})

		for (const id of ['active', 'failed', 'building', 'waiting', 'foreign']) {
			await db.createRun({
				id,
				appId: 'app',
				env: id === 'foreign' ? 'foreign' : 'prod',
				ref: 'refs/heads/main',
				trigger: 'manual',
			})
		}
		for (const id of ['active', 'failed', 'building', 'foreign']) {
			await db.markRunStarted(id, `runs/${id}/logs.ndjson`)
			await db.setRunExternalId(id, id)
		}

		const released: string[] = []
		const environments: string[] = []
		const summary = await reconcileProviderRuns({
			database: db,
			provider: provider(
				{
					active: { state: 'succeeded' },
					failed: { state: 'failed', exitCode: 23 },
					building: { state: 'running' },
				},
				environments,
			),
			releaseLock: (key, holder) => {
				released.push(`${key}/${holder}`)
				return Promise.resolve()
			},
		})

		expect(summary).toEqual({
			checked: 3,
			succeeded: 1,
			failed: 1,
			inProgress: 1,
			waiting: 1,
		})
		expect((await db.getRun('active'))?.status).toBe('succeeded')
		expect((await db.getRun('failed'))?.status).toBe('failed')
		expect((await db.getRun('failed'))?.exit_code).toBe(23)
		expect((await db.getRun('building'))?.status).toBe('running')
		expect((await db.getRun('waiting'))?.status).toBe('pending')
		expect((await db.getRun('foreign'))?.status).toBe('running')
		expect(released).toEqual(['app:prod/active', 'app:prod/failed'])
		expect(environments).toEqual([
			'harbor:{"kind":"target"}',
			'harbor:{"kind":"target"}',
			'harbor:{"kind":"target"}',
		])
	})

	test('keeps provider-owned runs in progress when reconciliation is not a provider capability', async () => {
		const { db } = createHarness()
		await db.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.upsertAppEnv(providerEnvironment('app', 'prod'))
		await db.createRun({ id: 'owned', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await db.markRunStarted('owned', 'runs/owned/logs.ndjson')
		await db.setRunExternalId('owned', 'operation')
		await db.createRun({ id: 'waiting', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })

		const summary = await reconcileProviderRuns({
			database: db,
			provider: {
				id: TEST_PROVIDER_ID,
				normalizeRegistration: (input) => input,
				deploy: () => Promise.resolve({ state: 'succeeded' }),
			},
			releaseLock: () => Promise.reject(new Error('release must not be called')),
		})

		expect(summary).toEqual({
			checked: 0,
			succeeded: 0,
			failed: 0,
			inProgress: 1,
			waiting: 1,
		})
		expect((await db.getRun('owned'))?.status).toBe('running')
		expect((await db.getRun('waiting'))?.status).toBe('pending')
	})
})
