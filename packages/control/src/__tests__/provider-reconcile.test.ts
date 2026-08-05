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
			environments.push(
				`${input.environment.namespace?.id ?? 'none'}:${input.environment.target.provider}:${JSON.stringify(input.environment.target.payload)}`,
			)
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
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.createDeploymentNamespace({
			id: 'apps-prod',
			env: 'prod',
			provider: TEST_PROVIDER_ID,
			exclusiveAppId: null,
			providerTargetJson: JSON.stringify({ provider: TEST_PROVIDER_ID, version: 1, payload: { dock: 'shared' } }),
			state: 'failed',
		})
		await db.registry.upsertAppEnv({ ...providerEnvironment('app', 'prod'), namespaceId: 'apps-prod' })
		await db.registry.upsertAppEnv({
			appId: 'app',
			env: 'foreign',
			namespaceId: null,
			provider: 'other',
			providerTargetJson: JSON.stringify({ provider: 'other', version: 1, payload: {} }),
			providerArtifactJson: JSON.stringify({ provider: 'other', version: 1, payload: {} }),
		})

		for (const id of ['active', 'failed', 'building', 'waiting', 'foreign']) {
			await db.runs.createRun({
				id,
				appId: 'app',
				env: id === 'foreign' ? 'foreign' : 'prod',
				ref: 'refs/heads/main',
				trigger: 'manual',
			})
		}
		for (const id of ['active', 'failed', 'building', 'foreign']) {
			await db.runs.markRunStarted(id, `runs/${id}/logs.ndjson`)
			await db.runs.setRunExternalId(id, id)
		}

		const released: string[] = []
		const environments: string[] = []
		const summary = await reconcileProviderRuns({
			repositories: db,
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
		expect((await db.runs.getRun('active'))?.status).toBe('succeeded')
		expect((await db.runs.getRun('failed'))?.status).toBe('failed')
		expect((await db.runs.getRun('failed'))?.exit_code).toBe(23)
		expect((await db.runs.getRun('building'))?.status).toBe('running')
		expect((await db.runs.getRun('waiting'))?.status).toBe('pending')
		expect((await db.runs.getRun('foreign'))?.status).toBe('running')
		expect(released).toEqual(['app:prod/active', 'app:prod/failed'])
		expect(environments).toEqual([
			'apps-prod:harbor:{"kind":"target"}',
			'apps-prod:harbor:{"kind":"target"}',
			'apps-prod:harbor:{"kind":"target"}',
		])
	})

	test('retries provider post-work after a crash and projects terminal state only after success', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		await db.runs.createRun({
			id: 'recovering',
			appId: 'app',
			env: 'prod',
			ref: 'refs/heads/main',
			trigger: 'manual',
			commitSha: '0123456789abcdef0123456789abcdef01234567',
		})
		await db.runs.markRunStarted('recovering', 'runs/recovering/logs.ndjson')
		await db.runs.setRunExternalId('recovering', 'version-1')

		let postWorkAttempts = 0
		let deploys = 0
		const controlProvider: ControlProvider = {
			id: TEST_PROVIDER_ID,
			normalizeRegistration: (input) => input,
			deploy: () => {
				deploys++
				return Promise.resolve({ state: 'succeeded' })
			},
			reconcile: () => {
				postWorkAttempts++
				if (postWorkAttempts === 1) {
					return Promise.reject(new Error('process stopped during post-provider work'))
				}
				return Promise.resolve({ state: 'succeeded' })
			},
		}
		const released: string[] = []
		const deps = {
			repositories: db,
			provider: controlProvider,
			releaseLock: (key: string, holder: string) => {
				released.push(`${key}/${holder}`)
				return Promise.resolve()
			},
			operations: { repository: db.operationsReleases },
		}

		await expect(reconcileProviderRuns(deps)).rejects.toThrow('process stopped during post-provider work')
		expect((await db.runs.getRun('recovering'))?.status).toBe('running')
		expect(await db.operationsReleases.get('recovering')).toBeNull()
		expect(released).toEqual([])

		expect(await reconcileProviderRuns(deps)).toEqual({
			checked: 1,
			succeeded: 1,
			failed: 0,
			inProgress: 0,
			waiting: 0,
		})
		expect((await db.runs.getRun('recovering'))?.status).toBe('succeeded')
		const projection = await db.operationsReleases.get('recovering')
		expect(projection?.payload_json).toContain('"phase":"terminal"')
		expect(projection?.payload_json).toContain('"outcome":"succeeded"')
		expect(released).toEqual(['app:prod/recovering'])

		expect(await reconcileProviderRuns(deps)).toEqual({
			checked: 0,
			succeeded: 0,
			failed: 0,
			inProgress: 0,
			waiting: 0,
		})
		expect(postWorkAttempts).toBe(2)
		expect(deploys).toBe(0)
	})

	test('projects the app return origins into a resumed deploy the same way a fresh one does', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod', { publicOrigin: 'https://app.example.test' }))
		await db.registry.upsertAppEnv(providerEnvironment('app', 'stage', { publicOrigin: 'https://stage.app.example.test' }))
		await db.runs.createRun({ id: 'resumed', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await db.runs.markRunStarted('resumed', 'runs/resumed/logs.ndjson')
		await db.runs.setRunExternalId('resumed', 'operation')

		const projected: Array<readonly string[] | undefined> = []
		await reconcileProviderRuns({
			repositories: db,
			provider: {
				id: TEST_PROVIDER_ID,
				normalizeRegistration: (input) => input,
				deploy: () => Promise.resolve({ state: 'succeeded' }),
				reconcile: (input) => {
					projected.push(input.returnOrigins)
					return Promise.resolve({ state: 'succeeded' })
				},
			},
			releaseLock: () => Promise.resolve(),
		})

		expect(projected).toEqual([['https://app.example.test', 'https://stage.app.example.test']])
	})

	test('keeps provider-owned runs in progress when reconciliation is not a provider capability', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		await db.runs.createRun({ id: 'owned', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await db.runs.markRunStarted('owned', 'runs/owned/logs.ndjson')
		await db.runs.setRunExternalId('owned', 'operation')
		await db.runs.createRun({ id: 'waiting', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })

		const summary = await reconcileProviderRuns({
			repositories: db,
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
		expect((await db.runs.getRun('owned'))?.status).toBe('running')
		expect((await db.runs.getRun('waiting'))?.status).toBe('pending')
	})
})
