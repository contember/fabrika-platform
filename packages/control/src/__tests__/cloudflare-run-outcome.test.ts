import type { AuthContext } from '@fabrika/auth'
import { permits } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { createCloudflareControlProvider } from '@fabrika/provider-cloudflare/runner'
import type { ControlProvider } from '@fabrika/provider-contract'
import type { RunnerStatus } from '@fabrika/runner-cloudflare'
import { describe, expect, spyOn, test } from 'bun:test'
import { ControlApiError } from '../api/domain'
import { setEnvironmentProtectionUseCase } from '../approval/api'
import { type ControlRepositories } from '../db'
import type { IamSchemaPort } from '../iam-schema'
import { type CloudflareRunnerService, recoverRunOnRunner, startRunOnRunner } from '../platform-cf'
import { reconcileProviderRuns } from '../provider-reconcile'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { memoryCommits } from './helpers/commits'
import { BASE } from './helpers/contracts'
import { createHarness } from './helpers/harness'
import { fixtureProtect, fixtureRuns, makeFakeLock } from './helpers/lock'

// Control is the only writer of a Cloudflare run's row (ADR-0044). The runner persists its terminal
// status, and Control applies the approved contract's IAM schema once (ADR-0011), either on the awaited
// `startRun` result or, after a Control restart, on the next provider reconcile.

const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'
const RUNNER_KEY = 'test-runner-key'

async function seedCloudflareRun(db: ControlRepositories): Promise<string> {
	await db.registry.createApp({ id: 'notes', repoUrl: 'github.com/acme/notes', configPath: 'fabrika.config.ts' })
	await db.registry.upsertAppEnv({
		appId: 'notes',
		env: 'prod',
		namespaceId: null,
		provider: 'cloudflare',
		providerTargetJson: JSON.stringify({ provider: 'cloudflare', version: 1, payload: {} }),
		providerArtifactJson: JSON.stringify({ provider: 'cloudflare', version: 1, payload: { configPath: 'fabrika.config.ts' } }),
	})
	// Unprotected, so the contract publishes and its schema applies without an approval (ADR-0050).
	await fixtureProtect(db.registry, makeFakeLock(db), { appId: 'notes', env: 'prod' }, false)
	const runId = uuidv7()
	await db.runs.createRun({ id: runId, appId: 'notes', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test', commitSha: COMMIT })
	return runId
}

/** A runner that persists the terminal status like the real Worker; `startRun` can lose its caller after persisting. */
function fakeRunner(options: { callerLost: boolean }): { service: CloudflareRunnerService; persisted: Map<string, RunnerStatus> } {
	const persisted = new Map<string, RunnerStatus>()
	const service: CloudflareRunnerService = {
		startRun: async (job) => {
			const status: RunnerStatus = {
				runId: job.runId,
				state: 'succeeded',
				exitCode: 0,
				startedAt: 1,
				finishedAt: 2,
			}
			persisted.set(job.runId, status)
			if (options.callerLost) throw new Error('RPC aborted: the calling isolate was replaced')
			return { status, lineCount: 1 }
		},
		cancelRun: async () => {},
		recoverRun: async (runId) => persisted.get(runId) ?? null,
	}
	return { service, persisted }
}

function cloudflareProvider(runner: CloudflareRunnerService): ControlProvider {
	return createCloudflareControlProvider({
		accountId: 'account',
		apiToken: 'token',
		runnerKey: RUNNER_KEY,
		resolveSource: async () => ({ commitSha: COMMIT }),
		prepareClone: async (source) => ({ repoUrl: `https://${source.repoUrl}` }),
		startRun: (job) => startRunOnRunner(runner, job),
		cancelRun: async () => {},
		recoverRun: (runId) => recoverRunOnRunner(runner, runId, RUNNER_KEY),
	})
}

/** Control's IAM port, recording the IAM application id of every schema it applies. */
function iam(iamCalls: string[], afterIam: () => void = () => {}): IamSchemaPort {
	return {
		apply: async (input) => {
			iamCalls.push(input.app)
			afterIam()
		},
	}
}

function deps(
	db: ControlRepositories,
	provider: ControlProvider,
	iamSchema: IamSchemaPort,
	files: Record<string, string> = { 'fabrika.contract.ts': BASE },
): RunDeps {
	return {
		repositories: db,
		provider,
		iamSchema,
		secrets: new VaultSecretResolver({}),
		lock: makeFakeLock(db),
		logs: { put: () => Promise.resolve() },
		commits: memoryCommits(files),
	}
}

describe('Cloudflare run outcome through Control', () => {
	test('a commit without `fabrika.contract.ts` fails its run before the runner starts, and applies nothing', async () => {
		const { db } = createHarness()
		const runId = await seedCloudflareRun(db)
		const iamCalls: string[] = []
		const { service, persisted } = fakeRunner({ callerLost: false })

		expect(await executeDeploy(deps(db, cloudflareProvider(service), iam(iamCalls), {}), { runId })).toEqual({ runId, status: 'failed' })
		expect(persisted.size).toBe(0)
		expect(iamCalls).toEqual([])
		expect(await db.registry.getAppEnv('notes', 'prod')).toMatchObject({ published_run_id: null })
	})

	test('the awaited result applies the IAM reconcile once and marks the run terminal once; redelivery and reconcile add nothing', async () => {
		const { db } = createHarness()
		const runId = await seedCloudflareRun(db)
		const iamCalls: string[] = []
		const { service } = fakeRunner({ callerLost: false })
		const provider = cloudflareProvider(service)

		expect(await executeDeploy(deps(db, provider, iam(iamCalls)), { runId })).toEqual({ runId, status: 'succeeded' })
		expect(iamCalls).toEqual(['notes@prod'])
		const finished = await db.runs.getRun(runId)
		expect(finished?.status).toBe('succeeded')

		expect(await executeDeploy(deps(db, provider, iam(iamCalls)), { runId })).toEqual({ runId, status: 'skipped' })
		expect(await reconcileProviderRuns(deps(db, provider, iam(iamCalls)))).toMatchObject({ checked: 0, succeeded: 0 })
		expect(iamCalls).toEqual(['notes@prod'])
		expect(await db.runs.getRun(runId)).toEqual(finished)
	})

	test('a runner that finishes while Control is unavailable is settled by the next reconcile, applying its IAM reconcile once', async () => {
		const { db } = createHarness()
		const runId = await seedCloudflareRun(db)
		const iamCalls: string[] = []
		const { service, persisted } = fakeRunner({ callerLost: true })

		expect(await executeDeploy(deps(db, cloudflareProvider(service), iam(iamCalls)), { runId })).toEqual({ runId, status: 'running' })
		expect(persisted.get(runId)?.state).toBe('succeeded')
		expect((await db.runs.getRun(runId))?.status).toBe('running')
		expect(iamCalls).toEqual([])

		const restarted = cloudflareProvider(service)
		expect(await reconcileProviderRuns(deps(db, restarted, iam(iamCalls)))).toMatchObject({ checked: 1, succeeded: 1 })
		expect(iamCalls).toEqual(['notes@prod'])
		const settled = await db.runs.getRun(runId)
		expect(settled?.status).toBe('succeeded')
		expect(settled?.exit_code).toBe(0)

		expect(await reconcileProviderRuns(deps(db, restarted, iam(iamCalls)))).toMatchObject({ checked: 0, succeeded: 0 })
		expect(await executeDeploy(deps(db, restarted, iam(iamCalls)), { runId })).toEqual({ runId, status: 'skipped' })
		expect(iamCalls).toEqual(['notes@prod'])
		expect(await db.runs.getRun(runId)).toEqual(settled)
	})

	test('a reconcile of a run still in flight leaves it running and applies nothing', async () => {
		const { db } = createHarness()
		const runId = await seedCloudflareRun(db)
		const owned = fixtureRuns(db.runs, makeFakeLock(db))
		await owned.start(runId, `runs/${runId}/logs.ndjson`)
		await owned.externalId(runId, runId, null)
		const iamCalls: string[] = []
		const { service } = fakeRunner({ callerLost: false })

		expect(await reconcileProviderRuns(deps(db, cloudflareProvider(service), iam(iamCalls)))).toMatchObject({ checked: 1, inProgress: 1 })
		expect((await db.runs.getRun(runId))?.status).toBe('running')
		expect(iamCalls).toEqual([])
	})

	test('a lease lost after the IAM apply re-applies the same schema on the next reconcile and settles the run once', async () => {
		const { db, sqlite } = createHarness()
		const runId = await seedCloudflareRun(db)
		const iamCalls: string[] = []
		const { service } = fakeRunner({ callerLost: true })
		expect(await executeDeploy(deps(db, cloudflareProvider(service), iam(iamCalls)), { runId })).toEqual({ runId, status: 'running' })

		let stolen = false
		const stealLease = (): void => {
			if (stolen) return
			stolen = true
			sqlite.run(`UPDATE deploy_locks SET holder = 'intruder'`)
		}
		const restarted = cloudflareProvider(service)
		const stealing = iam(iamCalls, stealLease)
		const diagnostic = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect(await reconcileProviderRuns(deps(db, restarted, stealing))).toMatchObject({ checked: 1, succeeded: 0, inProgress: 1 })
		} finally {
			diagnostic.mockRestore()
		}
		expect(iamCalls).toEqual(['notes@prod'])
		expect((await db.runs.getRun(runId))?.status).toBe('running')

		// The intruder's lease expires.
		sqlite.run('DELETE FROM deploy_locks')
		expect(await reconcileProviderRuns(deps(db, restarted, stealing))).toMatchObject({ checked: 1, succeeded: 1 })
		expect(iamCalls).toEqual(['notes@prod', 'notes@prod'])
		const settled = await db.runs.getRun(runId)
		expect(settled?.status).toBe('succeeded')
		expect(await reconcileProviderRuns(deps(db, restarted, stealing))).toMatchObject({ checked: 0 })
		expect(iamCalls).toEqual(['notes@prod', 'notes@prod'])
		expect(await db.runs.getRun(runId)).toEqual(settled)
	})

	test('a human cannot protect the environment while a Cloudflare job runs under the old flag, nor while its outcome is unsettled', async () => {
		const { db } = createHarness()
		const runId = await seedCloudflareRun(db)
		const ORIGIN = 'https://control.example.test'
		const human: AuthContext = {
			ok: true,
			principal: { id: 'p-ada', type: 'user', label: 'ada@example.test' },
			can: (action, scope) => permits([{ action: 'access.approve', scope: null, source: 'grant' }], action, scope),
			scopedTo: () => null,
			audit: () => Promise.resolve(),
		}
		const protect = async (): Promise<number> => {
			try {
				await setEnvironmentProtectionUseCase({
					repositories: db,
					auth: human,
					queue: { send: () => Promise.resolve() },
					lock: makeFakeLock(db),
					request: new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' } }),
				}, { appId: 'notes', env: 'prod', protected: true })
				return 200
			} catch (error) {
				return error instanceof ControlApiError ? error.httpStatus : 500
			}
		}
		const during: number[] = []
		const persisted = new Map<string, RunnerStatus>()
		const runner = (callerLost: boolean): CloudflareRunnerService => ({
			startRun: async (job) => {
				during.push(await protect())
				const status: RunnerStatus = {
					runId: job.runId,
					state: 'succeeded',
					exitCode: 0,
					startedAt: 1,
					finishedAt: 2,
				}
				persisted.set(job.runId, status)
				if (callerLost) throw new Error('RPC aborted: the calling isolate was replaced')
				return { status, lineCount: 1 }
			},
			cancelRun: async () => {},
			recoverRun: async (id) => persisted.get(id) ?? null,
		})
		const iamCalls: string[] = []

		expect(await executeDeploy(deps(db, cloudflareProvider(runner(false)), iam(iamCalls)), { runId })).toEqual({ runId, status: 'succeeded' })
		expect(during).toEqual([409])
		expect(iamCalls).toEqual(['notes@prod'])
		expect(await db.registry.getAppEnv('notes', 'prod')).toMatchObject({ protected: 0, protection_revision: 1 })

		const orphaned = uuidv7()
		await db.runs.createRun({
			id: orphaned,
			appId: 'notes',
			env: 'prod',
			ref: 'refs/heads/main',
			trigger: 'manual',
			actor: 'user:test',
			commitSha: COMMIT,
		})
		expect(await executeDeploy(deps(db, cloudflareProvider(runner(true)), iam(iamCalls)), { runId: orphaned })).toEqual({
			runId: orphaned,
			status: 'running',
		})
		expect(await protect()).toBe(409)
		expect(await reconcileProviderRuns(deps(db, cloudflareProvider(runner(true)), iam(iamCalls)))).toMatchObject({ checked: 1, succeeded: 1 })
		expect(await protect()).toBe(200)
		expect(await db.registry.getAppEnv('notes', 'prod')).toMatchObject({ protected: 1, protection_revision: 2 })
	})
})
