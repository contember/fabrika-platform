import type { DeployLocks } from '@fabrika/platform'
import type { ControlProvider, JsonValue, ProviderReconcileOutcome } from '@fabrika/provider-contract'
import type { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import type { ControlRepositories } from '../db'
import { type ProviderReconcileSummary, reconcileProviderRuns } from '../provider-reconcile'
import { createHarness } from './helpers/harness'
import { fixtureRuns, makeFakeLock } from './helpers/lock'
import { providerEnvironment, TEST_PROVIDER_ID } from './helpers/provider'

function trackedLock(db: ControlRepositories, release: (key: string, holder: string) => Promise<void>): DeployLocks {
	const lock = makeFakeLock(db)
	return {
		acquire: (key, holder, ttlMs) => lock.acquire(key, holder, ttlMs),
		renew: (key, holder, ttlMs) => lock.renew(key, holder, ttlMs),
		release: async (key, holder) => {
			await lock.release(key, holder)
			await release(key, holder)
		},
	}
}

const owned = (db: ControlRepositories) => fixtureRuns(db.runs, makeFakeLock(db))

/** The fenced start refuses a second running run per environment, so several are seeded as raw rows. */
function seedRunning(sqlite: Database, id: string, externalId: string, state?: JsonValue): void {
	sqlite.run(
		`UPDATE runs SET status = 'running', started_at = created_at, log_key = ?, external_run_id = ?, provider_state_json = ? WHERE id = ?`,
		[`runs/${id}/logs.ndjson`, externalId, state === undefined ? null : JSON.stringify(state), id],
	)
}

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
	test('retries durable provider cancellation without reconciling or losing checkpoint state', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		await db.runs.createRun({ id: 'cancelling', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await owned(db).start('cancelling', 'runs/cancelling/logs.ndjson')
		await owned(db).externalId('cancelling', 'operation', { phase: 'uploaded' })
		await db.runs.requestRunCancellation('cancelling')

		let cancellationAttempts = 0
		let reconcileAttempts = 0
		const states: unknown[] = []
		const released: string[] = []
		const controlProvider: ControlProvider = {
			id: TEST_PROVIDER_ID,
			normalizeRegistration: (input) => input,
			deploy: () => Promise.resolve({ state: 'succeeded' }),
			cancel: (input) => {
				cancellationAttempts++
				states.push(input.providerState)
				if (cancellationAttempts === 1) return Promise.reject(new Error('temporary cancel failure'))
				return Promise.resolve({ state: 'settled' })
			},
			reconcile: () => {
				reconcileAttempts++
				return Promise.resolve({ state: 'succeeded' })
			},
		}
		const deps = {
			repositories: db,
			provider: controlProvider,
			lock: trackedLock(db, (key, holder) => {
				released.push(`${key}/${holder}`)
				return Promise.resolve()
			}),
		}

		expect(await reconcileProviderRuns(deps)).toMatchObject({ checked: 1, inProgress: 1 })
		expect((await db.runs.getRun('cancelling'))?.status).toBe('running')
		expect((await db.runs.getRun('cancelling'))?.cancel_requested_at).not.toBeNull()
		expect(released).toHaveLength(1)

		expect(await reconcileProviderRuns(deps)).toMatchObject({ checked: 1, failed: 1 })
		expect((await db.runs.getRun('cancelling'))?.status).toBe('failed')
		expect(states).toEqual([{ phase: 'uploaded' }, { phase: 'uploaded' }])
		expect(reconcileAttempts).toBe(0)
		expect(released).toHaveLength(2)
		expect(new Set(released).size).toBe(2)
	})

	test('a cancellation the provider settles as succeeded finishes the run succeeded, with the run start and return origins handed over', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod', { publicOrigin: 'https://app.example.test' }))
		await db.runs.createRun({ id: 'activated', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await owned(db).start('activated', 'runs/activated/logs.ndjson')
		await owned(db).externalId('activated', 'operation', { appVersionId: 'operation', triggered: true })
		await db.runs.requestRunCancellation('activated')
		const started = (await db.runs.getRun('activated'))?.started_at
		const startedAtMs: Array<number | undefined> = []
		const returnOrigins: Array<readonly string[] | undefined> = []

		expect(
			await reconcileProviderRuns({
				repositories: db,
				provider: {
					id: TEST_PROVIDER_ID,
					normalizeRegistration: (input) => input,
					deploy: () => Promise.resolve({ state: 'succeeded' }),
					cancel: (input) => {
						startedAtMs.push(input.startedAtMs)
						returnOrigins.push(input.returnOrigins)
						return Promise.resolve({ state: 'settled', outcome: 'succeeded' })
					},
				},
				lock: makeFakeLock(db),
			}),
		).toMatchObject({ checked: 1, succeeded: 1, failed: 0 })
		expect((await db.runs.getRun('activated'))?.status).toBe('succeeded')
		expect(startedAtMs).toEqual([(started ?? 0) * 1000])
		expect(returnOrigins).toEqual([['https://app.example.test']])
	})

	test('hands persisted provider checkpoint state to reconciliation', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		await db.runs.createRun({ id: 'resumed', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await owned(db).start('resumed', 'runs/resumed/logs.ndjson')
		await owned(db).externalId('resumed', 'operation', { appVersionId: 'version-1', phase: 'uploaded' })

		const states: unknown[] = []
		expect(
			await reconcileProviderRuns({
				repositories: db,
				provider: {
					id: TEST_PROVIDER_ID,
					normalizeRegistration: (input) => input,
					deploy: () => Promise.resolve({ state: 'succeeded' }),
					reconcile: (input) => {
						states.push(input.providerState)
						return Promise.resolve({ state: 'running' })
					},
				},
				lock: makeFakeLock(db),
			}),
		).toMatchObject({ checked: 1, inProgress: 1 })
		expect(states).toEqual([{ appVersionId: 'version-1', phase: 'uploaded' }])
	})

	test('finishes terminal operations through a third provider and leaves pending work untouched', async () => {
		const { db, sqlite } = createHarness()
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
		for (const id of ['active', 'failed', 'building', 'foreign']) seedRunning(sqlite, id, id)

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
			lock: trackedLock(db, (key, holder) => {
				released.push(`${key}/${holder}`)
				return Promise.resolve()
			}),
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
		expect(released).toHaveLength(4)
		expect(new Set(released).size).toBe(4)
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
		await owned(db).start('recovering', 'runs/recovering/logs.ndjson')
		await owned(db).externalId('recovering', 'version-1')

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
			lock: trackedLock(db, (key, holder) => {
				released.push(`${key}/${holder}`)
				return Promise.resolve()
			}),
			operations: { repository: db.operationsReleases },
		}

		expect(await reconcileProviderRuns(deps)).toMatchObject({ checked: 1, inProgress: 1 })
		expect((await db.runs.getRun('recovering'))?.status).toBe('running')
		expect(await db.operationsReleases.get('recovering')).toBeNull()
		expect(released).toHaveLength(1)

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
		expect(released).toHaveLength(2)

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
		await owned(db).start('resumed', 'runs/resumed/logs.ndjson')
		await owned(db).externalId('resumed', 'operation')

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
			lock: makeFakeLock(db),
		})

		expect(projected).toEqual([['https://app.example.test']])
	})

	test("projects the provider's artifact state and dry flag, and appends its log lines after the executor's", async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		await db.runs.createRun({ id: 'previewed', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await owned(db).start('previewed', 'runs/previewed/logs.ndjson')
		await owned(db).externalId('previewed', 'operation')

		const executorLine = JSON.stringify({ ts: 1, stream: 'stdout', text: 'executor output' })
		const objects = new Map([['runs/previewed/logs.ndjson', executorLine]])
		const projections: unknown[] = []
		expect(
			await reconcileProviderRuns({
				repositories: db,
				provider: {
					id: TEST_PROVIDER_ID,
					normalizeRegistration: (input) => input,
					deploy: () => Promise.resolve({ state: 'succeeded' }),
					reconcile: async (input) => {
						await input.log?.('settled by reconcile')
						return { state: 'succeeded', artifactState: 'not_applicable', dryRun: true }
					},
				},
				lock: makeFakeLock(db),
				projectTerminal: async (_deps, runId, dryRun, outcome, artifactState) => {
					projections.push({ runId, dryRun, outcome, artifactState })
				},
				runLogs: {
					get: async (key) => {
						const value = objects.get(key)
						return value === undefined ? null : { body: new Blob([value]).stream(), text: async () => value }
					},
					put: async (key, value) => {
						if (typeof value !== 'string') throw new Error('test log store accepts strings only')
						objects.set(key, value)
					},
				},
			}),
		).toMatchObject({ checked: 1, succeeded: 1 })

		expect(projections).toEqual([{ runId: 'previewed', dryRun: true, outcome: 'succeeded', artifactState: 'not_applicable' }])
		const lines = (objects.get('runs/previewed/logs.ndjson') ?? '').trim().split('\n').map((line) => JSON.parse(line))
		expect(lines).toEqual([
			{ ts: 1, stream: 'stdout', text: 'executor output' },
			expect.objectContaining({ stream: 'meta', text: 'settled by reconcile' }),
		])
	})

	test('keeps provider-owned runs in progress when reconciliation is not a provider capability', async () => {
		const { db } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		await db.runs.createRun({ id: 'owned', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
		await owned(db).start('owned', 'runs/owned/logs.ndjson')
		await owned(db).externalId('owned', 'operation')
		await db.runs.createRun({ id: 'waiting', appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })

		const summary = await reconcileProviderRuns({
			repositories: db,
			provider: {
				id: TEST_PROVIDER_ID,
				normalizeRegistration: (input) => input,
				deploy: () => Promise.resolve({ state: 'succeeded' }),
			},
			lock: makeFakeLock(db),
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

	test('isolates a malformed provider row, redacts its failure, and reconciles later rows', async () => {
		const { db, sqlite } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		for (const id of ['broken', 'healthy']) {
			await db.runs.createRun({ id, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
			seedRunning(sqlite, id, `${id}-operation`)
		}

		const secret = 'private-provider-response'
		const errors: string[] = []
		const originalError = console.error
		console.error = (...values) => errors.push(values.map(String).join(' '))
		let summary: ProviderReconcileSummary | undefined
		try {
			summary = await reconcileProviderRuns({
				repositories: db,
				provider: {
					id: TEST_PROVIDER_ID,
					normalizeRegistration: (input) => input,
					deploy: () => Promise.resolve({ state: 'succeeded' }),
					reconcile: (input) => {
						if (input.runId === 'broken') throw new Error(secret)
						return Promise.resolve({ state: 'succeeded' })
					},
				},
				lock: makeFakeLock(db),
			})
		} finally {
			console.error = originalError
		}

		expect(summary).toEqual({ checked: 2, succeeded: 1, failed: 0, inProgress: 1, waiting: 0 })
		expect((await db.runs.getRun('broken'))?.status).toBe('running')
		expect((await db.runs.getRun('healthy'))?.status).toBe('succeeded')
		expect(errors).toEqual(['provider reconcile failed for run broken'])
		expect(errors.join('\n')).not.toContain(secret)
		expect(errors.join('\n')).not.toContain('broken-operation')
	})

	test('keeps terminal counters truthful when lock release fails and continues after cancellation', async () => {
		const { db, sqlite } = createHarness()
		await db.registry.createApp({ id: 'app', repoUrl: 'github.com/o/app' })
		await db.registry.upsertAppEnv(providerEnvironment('app', 'prod'))
		for (const id of ['cancelling', 'failed', 'succeeded']) {
			await db.runs.createRun({ id, appId: 'app', env: 'prod', ref: 'main', trigger: 'manual' })
			seedRunning(sqlite, id, `${id}-operation`, { phase: 'accepted' })
		}
		await db.runs.requestRunCancellation('cancelling')

		const projectionSecret = 'private-projection-error'
		const releaseSecret = 'private-lock-driver-error'
		const errors: string[] = []
		const projected: string[] = []
		const releases: string[] = []
		const originalError = console.error
		console.error = (...values) => errors.push(values.map(String).join(' '))
		let summary: ProviderReconcileSummary | undefined
		try {
			summary = await reconcileProviderRuns({
				repositories: db,
				provider: {
					id: TEST_PROVIDER_ID,
					normalizeRegistration: (input) => input,
					deploy: () => Promise.resolve({ state: 'succeeded' }),
					cancel: () => Promise.resolve({ state: 'settled' }),
					reconcile: (input) => Promise.resolve(input.runId === 'failed' ? { state: 'failed' } : { state: 'succeeded' }),
				},
				projectTerminal: (_deps, runId) => {
					projected.push(runId)
					return Promise.reject(new Error(projectionSecret))
				},
				lock: trackedLock(db, (_key, holder) => {
					releases.push(holder)
					return Promise.reject(new Error(releaseSecret))
				}),
			})
		} finally {
			console.error = originalError
		}

		expect(summary).toEqual({ checked: 3, succeeded: 1, failed: 2, inProgress: 0, waiting: 0 })
		expect((await db.runs.getRun('cancelling'))?.status).toBe('failed')
		expect((await db.runs.getRun('failed'))?.status).toBe('failed')
		expect((await db.runs.getRun('succeeded'))?.status).toBe('succeeded')
		expect(projected).toEqual(['cancelling', 'failed', 'succeeded'])
		expect(releases).toHaveLength(3)
		expect(new Set(releases).size).toBe(3)
		expect(errors).toEqual([
			'provider reconcile terminal projection failed for run cancelling',
			'provider reconcile lock release failed for run cancelling',
			'provider reconcile terminal projection failed for run failed',
			'provider reconcile lock release failed for run failed',
			'provider reconcile terminal projection failed for run succeeded',
			'provider reconcile lock release failed for run succeeded',
		])
		expect(errors.join('\n')).not.toContain(projectionSecret)
		expect(errors.join('\n')).not.toContain(releaseSecret)
		expect(errors.join('\n')).not.toContain('-operation')
	})
})
