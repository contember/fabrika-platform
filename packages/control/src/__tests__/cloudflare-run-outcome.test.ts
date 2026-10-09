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
import { type CloudflareRunnerService, recoverRunOnRunner, startRunOnRunner } from '../platform-cf'
import { reconcileProviderRuns } from '../provider-reconcile'
import { executeDeploy, type RunDeps } from '../run-lifecycle'
import { VaultSecretResolver } from '../secret-resolver'
import { memoryCommits } from './helpers/commits'
import { createHarness } from './helpers/harness'
import { fixtureProtect, fixtureRuns, makeFakeLock } from './helpers/lock'

// Control is the only writer of a Cloudflare run's row (ADR-0044). The runner persists its terminal
// status — with the IAM reconcile the executor compiled — and Control applies that reconcile once,
// either on the awaited `startRun` result or, after a Control restart, from the next provider reconcile.

const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'
const RUNNER_KEY = 'test-runner-key'
const SCHEMA_JSON = '{"scopes":[],"actions":[{"action":"notes.read"}],"roles":{}}'

async function seedCloudflareRun(db: ControlRepositories): Promise<string> {
	await db.registry.createApp({ id: 'app', repoUrl: 'github.com/acme/app', configPath: 'fabrika.config.ts' })
	await db.registry.upsertAppEnv({
		appId: 'app',
		env: 'prod',
		namespaceId: null,
		provider: 'cloudflare',
		providerTargetJson: JSON.stringify({ provider: 'cloudflare', version: 1, payload: {} }),
		providerArtifactJson: JSON.stringify({ provider: 'cloudflare', version: 1, payload: { configPath: 'fabrika.config.ts' } }),
	})
	// Unprotected, so the schema the runner reports applies without an approval (ADR-0050).
	await fixtureProtect(db.registry, makeFakeLock(db), { appId: 'app', env: 'prod' }, false)
	const runId = uuidv7()
	await db.runs.createRun({ id: runId, appId: 'app', env: 'prod', ref: 'refs/heads/main', trigger: 'manual', actor: 'user:test', commitSha: COMMIT })
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
				artifactAccess: { state: 'deployed', accessJson: `{"gates":null,"schema":${SCHEMA_JSON}}` },
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

function cloudflareProvider(runner: CloudflareRunnerService, iamCalls: string[], afterIam: () => void = () => {}): ControlProvider {
	return createCloudflareControlProvider({
		accountId: 'account',
		apiToken: 'token',
		runnerKey: RUNNER_KEY,
		propustkaUrl: 'https://iam.example.com',
		propustkaProvisioningKey: 'px_admin',
		reconcileSchema: async (input) => {
			iamCalls.push(input.app)
			afterIam()
		},
		resolveSource: async () => ({ commitSha: COMMIT }),
		prepareClone: async (source) => ({ repoUrl: `https://${source.repoUrl}` }),
		startRun: (job) => startRunOnRunner(runner, job),
		cancelRun: async () => {},
		recoverRun: (runId) => recoverRunOnRunner(runner, runId, RUNNER_KEY),
	})
}

function deps(db: ControlRepositories, provider: ControlProvider): RunDeps {
	return {
		repositories: db,
		provider,
		secrets: new VaultSecretResolver({}),
		lock: makeFakeLock(db),
		logs: { put: () => Promise.resolve() },
		commits: memoryCommits(),
	}
}

describe('Cloudflare run outcome through Control', () => {
	test('the awaited result applies the IAM reconcile once and marks the run terminal once; redelivery and reconcile add nothing', async () => {
		const { db } = createHarness()
		const runId = await seedCloudflareRun(db)
		const iamCalls: string[] = []
		const { service } = fakeRunner({ callerLost: false })
		const provider = cloudflareProvider(service, iamCalls)

		expect(await executeDeploy(deps(db, provider), { runId })).toEqual({ runId, status: 'succeeded' })
		expect(iamCalls).toEqual(['app@prod'])
		const finished = await db.runs.getRun(runId)
		expect(finished?.status).toBe('succeeded')

		expect(await executeDeploy(deps(db, provider), { runId })).toEqual({ runId, status: 'skipped' })
		expect(await reconcileProviderRuns(deps(db, provider))).toMatchObject({ checked: 0, succeeded: 0 })
		expect(iamCalls).toEqual(['app@prod'])
		expect(await db.runs.getRun(runId)).toEqual(finished)
	})

	test('a runner that finishes while Control is unavailable is settled by the next reconcile, applying its IAM reconcile once', async () => {
		const { db } = createHarness()
		const runId = await seedCloudflareRun(db)
		const iamCalls: string[] = []
		const { service, persisted } = fakeRunner({ callerLost: true })

		expect(await executeDeploy(deps(db, cloudflareProvider(service, iamCalls)), { runId })).toEqual({ runId, status: 'running' })
		expect(persisted.get(runId)?.state).toBe('succeeded')
		expect((await db.runs.getRun(runId))?.status).toBe('running')
		expect(iamCalls).toEqual([])

		const restarted = cloudflareProvider(service, iamCalls)
		expect(await reconcileProviderRuns(deps(db, restarted))).toMatchObject({ checked: 1, succeeded: 1 })
		expect(iamCalls).toEqual(['app@prod'])
		const settled = await db.runs.getRun(runId)
		expect(settled?.status).toBe('succeeded')
		expect(settled?.exit_code).toBe(0)

		expect(await reconcileProviderRuns(deps(db, restarted))).toMatchObject({ checked: 0, succeeded: 0 })
		expect(await executeDeploy(deps(db, restarted), { runId })).toEqual({ runId, status: 'skipped' })
		expect(iamCalls).toEqual(['app@prod'])
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

		expect(await reconcileProviderRuns(deps(db, cloudflareProvider(service, iamCalls)))).toMatchObject({ checked: 1, inProgress: 1 })
		expect((await db.runs.getRun(runId))?.status).toBe('running')
		expect(iamCalls).toEqual([])
	})

	test('a lease lost after the IAM apply re-applies the same schema on the next reconcile and settles the run once', async () => {
		const { db, sqlite } = createHarness()
		const runId = await seedCloudflareRun(db)
		const iamCalls: string[] = []
		const { service } = fakeRunner({ callerLost: true })
		expect(await executeDeploy(deps(db, cloudflareProvider(service, iamCalls)), { runId })).toEqual({ runId, status: 'running' })

		let stolen = false
		const stealLease = (): void => {
			if (stolen) return
			stolen = true
			sqlite.run(`UPDATE deploy_locks SET holder = 'intruder'`)
		}
		const restarted = cloudflareProvider(service, iamCalls, stealLease)
		const diagnostic = spyOn(console, 'error').mockImplementation(() => {})
		try {
			expect(await reconcileProviderRuns(deps(db, restarted))).toMatchObject({ checked: 1, succeeded: 0, inProgress: 1 })
		} finally {
			diagnostic.mockRestore()
		}
		expect(iamCalls).toEqual(['app@prod'])
		expect((await db.runs.getRun(runId))?.status).toBe('running')

		// The intruder's lease expires.
		sqlite.run('DELETE FROM deploy_locks')
		expect(await reconcileProviderRuns(deps(db, restarted))).toMatchObject({ checked: 1, succeeded: 1 })
		expect(iamCalls).toEqual(['app@prod', 'app@prod'])
		const settled = await db.runs.getRun(runId)
		expect(settled?.status).toBe('succeeded')
		expect(await reconcileProviderRuns(deps(db, restarted))).toMatchObject({ checked: 0 })
		expect(iamCalls).toEqual(['app@prod', 'app@prod'])
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
				}, { appId: 'app', env: 'prod', protected: true })
				return 200
			} catch (error) {
				return error instanceof ControlApiError ? error.httpStatus : 500
			}
		}
		const wider =
			'{"scopes":[],"actions":[{"action":"notes.read"},{"action":"notes.delete"}],"roles":{"deleter":{"name":"Deleter","permissions":["notes.delete"]}}}'
		const during: number[] = []
		const persisted = new Map<string, RunnerStatus>()
		const runner = (callerLost: boolean): CloudflareRunnerService => ({
			startRun: async (job) => {
				during.push(await protect())
				const status: RunnerStatus = {
					runId: job.runId,
					state: 'succeeded',
					exitCode: 0,
					artifactAccess: { state: 'deployed', accessJson: `{"gates":{"rules":[{"path":"/*","kind":"public"}]},"schema":${wider}}` },
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

		expect(await executeDeploy(deps(db, cloudflareProvider(runner(false), iamCalls)), { runId })).toEqual({ runId, status: 'succeeded' })
		expect(during).toEqual([409])
		expect(iamCalls).toEqual(['app@prod'])
		expect(await db.registry.getAppEnv('app', 'prod')).toMatchObject({ protected: 0, protection_revision: 1 })

		const orphaned = uuidv7()
		await db.runs.createRun({
			id: orphaned,
			appId: 'app',
			env: 'prod',
			ref: 'refs/heads/main',
			trigger: 'manual',
			actor: 'user:test',
			commitSha: COMMIT,
		})
		expect(await executeDeploy(deps(db, cloudflareProvider(runner(true), iamCalls)), { runId: orphaned })).toEqual({
			runId: orphaned,
			status: 'running',
		})
		expect(await protect()).toBe(409)
		expect(await reconcileProviderRuns(deps(db, cloudflareProvider(runner(true), iamCalls)))).toMatchObject({ checked: 1, succeeded: 1 })
		expect(await protect()).toBe(200)
		expect(await db.registry.getAppEnv('app', 'prod')).toMatchObject({ protected: 1, protection_revision: 2 })
	})
})
