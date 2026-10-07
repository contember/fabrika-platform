import {
	cloudflareArtifact,
	cloudflareArtifactCodec,
	type CloudflareRunnerJob,
	cloudflareStoredTargetCodec,
	createCloudflareControlProvider,
} from '@fabrika/provider-cloudflare'
import type { ProviderDeployInput, ProviderEnvelope } from '@fabrika/provider-contract'
import type { RelayResult, RunnerStatus } from '@fabrika/runner-cloudflare'
import { describe, expect, spyOn, test } from 'bun:test'
import {
	cancelRunOnRunner,
	cloudflareControlProvider,
	cloudflareIamControlOptions,
	type CloudflareRunnerService,
	controlEnv,
	recoverRunOnRunner,
	startRunOnRunner,
	type WorkerBindings,
} from '../platform-cf'
import { GitHubAppRepoSource } from '../repo-source'
import { createHarness } from './helpers/harness'

const envelope = <T>(codec: { version: number; encode(value: T): ProviderEnvelope['payload'] }, value: T): ProviderEnvelope => ({
	provider: 'cloudflare',
	version: codec.version,
	payload: codec.encode(value),
})

const deployInput = (): ProviderDeployInput => ({
	runId: 'run-1',
	app: {
		id: 'api',
		source: {
			repoUrl: 'https://github.com/example/api.git',
			ref: 'abcdef1234567890abcdef1234567890abcdef12',
		},
	},
	environment: {
		appId: 'api',
		env: 'production',
		domain: 'api.example.com',
		publicOrigin: 'https://public.example.com',
		target: envelope(cloudflareStoredTargetCodec, { stateNamespace: 'api-state' }),
		artifact: envelope(cloudflareArtifactCodec, cloudflareArtifact('deploy.config.ts')),
	},
	secrets: {},
	vars: {},
	managedEnvironment: {},
	dryRun: false,
	signal: new AbortController().signal,
	events: {
		log: () => {},
		externalId: async () => {},
		checkpoint: async () => {},
	},
})

describe('Cloudflare control IAM options', () => {
	// This test used to assert the OPPOSITE — that the IAM coordinates ride into the job's credentials
	// under their canonical names. They must not: the container runs the checkout's own code, and
	// FABRIKA_IAM_PROVISIONING_KEY resolves in IAM to a global admin. The coordinates configure the
	// PROVIDER, which applies the reconcile itself.
	test('the IAM coordinates configure the provider and never reach the job', async () => {
		const env = {
			FABRIKA_IAM_ISSUER: 'https://iam.example.test',
			FABRIKA_IAM_PROVISIONING_KEY: 'px_provisioning',
		}
		expect(cloudflareIamControlOptions(env)).toEqual({
			propustkaUrl: 'https://iam.example.test',
			propustkaProvisioningKey: 'px_provisioning',
		})

		const jobs: CloudflareRunnerJob[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...cloudflareIamControlOptions(env),
			resolveSource: async () => ({ commitSha: deployInput().app.source.ref }),
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async (job) => {
				jobs.push(job)
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})

		await provider.deploy(deployInput())

		expect(jobs).toHaveLength(1)
		expect(Object.keys(jobs[0]?.credentials ?? {})).toEqual(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'])
	})
})

describe('the Cloudflare source composition', () => {
	test('resolves the recorded commit or requested ref through the concrete adapter; a missing runner binding refuses acceptance', async () => {
		const harness = createHarness()
		const effects: string[] = []
		const input = deployInput()
		const resolution = spyOn(GitHubAppRepoSource.prototype, 'resolveCommit').mockResolvedValue({ commitSha: input.app.source.ref })
		const clone = spyOn(GitHubAppRepoSource.prototype, 'clone').mockResolvedValue({ cloneUrl: 'https://github.com/example/api', ref: 'b'.repeat(40) })
		const unexpected = (): never => {
			throw new Error('unexpected binding access')
		}
		const bindings: WorkerBindings = {
			ENVIRONMENT: 'stage',
			DB: harness.d1,
			ASSETS: { fetch: unexpected, connect: unexpected },
			RUN_LOGS: {
				head: unexpected,
				get: unexpected,
				put: unexpected,
				createMultipartUpload: unexpected,
				resumeMultipartUpload: unexpected,
				delete: unexpected,
				list: unexpected,
			},
			DEPLOY_QUEUE: { send: unexpected, sendBatch: unexpected, metrics: unexpected },
			FABRIKA_RUNNER_KEY: 'test-runner-key',
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		}
		try {
			const provider = cloudflareControlProvider(bindings, controlEnv(bindings, () => {}))
			if (provider.resolveSource === undefined) throw new Error('missing resolver')
			const source = { ...input.app.source, ref: 'refs/heads/main' }
			const selection = { ...input, app: { ...input.app, source }, sourceBinding: { installationId: 99 }, expectedCommitSha: input.app.source.ref }
			expect(await provider.resolveSource(selection)).toEqual({ commitSha: input.app.source.ref })
			expect(resolution.mock.calls[0]).toEqual([source.repoUrl, input.app.source.ref, 99, input.signal])
			const { expectedCommitSha: _recorded, ...unrecorded } = selection
			await provider.resolveSource(unrecorded)
			expect(resolution.mock.calls[1]).toEqual([source.repoUrl, source.ref, 99, input.signal])
			expect(clone).not.toHaveBeenCalled()
			expect(effects).toEqual([])
			await expect(provider.deploy({
				...input,
				app: { ...input.app, source: { ...source, ref: input.app.source.ref } },
				sourceBinding: { installationId: 99 },
				events: {
					...input.events,
					externalId: async () => {
						effects.push('accepted')
					},
				},
			})).rejects.toThrow('Cloudflare provider requires the RUNNER_SVC service binding')
			expect(clone.mock.calls[0]).toEqual([source.repoUrl, input.app.source.ref, 99, input.signal])
			expect(effects).toEqual([])
		} finally {
			resolution.mockRestore()
			clone.mockRestore()
			harness.sqlite.close()
		}
	})
})

// The runner port. vozka-runner refuses any RPC that does not present FABRIKA_RUNNER_KEY, so both
// directions are pinned here: the key control sends on a cancel, and the terminal outcome it reads
// back — the executor's compiled IAM reconcile rides on the status, because core, not the untrusted
// container, is what applies it with the IAM admin key.

interface RunnerCall {
	readonly method: 'startRun' | 'cancelRun' | 'recoverRun'
	readonly runId: string
	readonly runnerKey: string | undefined
}

function fakeRunner(calls: RunnerCall[], result: RelayResult, persisted: RunnerStatus | null = null): CloudflareRunnerService {
	return {
		startRun: async (job) => {
			calls.push({ method: 'startRun', runId: job.runId, runnerKey: job.runnerKey })
			return result
		},
		cancelRun: async (runId, runnerKey) => {
			calls.push({ method: 'cancelRun', runId, runnerKey })
		},
		recoverRun: async (runId, runnerKey) => {
			calls.push({ method: 'recoverRun', runId, runnerKey })
			return persisted
		},
	}
}

const job = (): CloudflareRunnerJob => ({
	runId: 'run-1',
	repoUrl: 'https://github.com/example/api.git',
	ref: 'abcdef1234567890abcdef1234567890abcdef12',
	env: 'production',
	runnerKey: 'test-runner-key',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'account-1', CLOUDFLARE_API_TOKEN: 'token-1' },
})

describe('the Cloudflare runner port', () => {
	test("the executor's IAM reconcile rides back on the terminal outcome", async () => {
		const calls: RunnerCall[] = []
		const result: RelayResult = {
			lineCount: 3,
			status: {
				runId: 'run-1',
				state: 'succeeded',
				exitCode: 0,
				artifactState: 'complete',
				iamReconcile: { app: 'api', schemaJson: '{"actions":[]}' },
				startedAt: 1,
				finishedAt: 9,
			},
		}

		const outcome = await startRunOnRunner(fakeRunner(calls, result), job())

		expect(outcome).toEqual({
			state: 'succeeded',
			exitCode: 0,
			artifactState: 'complete',
			iamReconcile: { app: 'api', schemaJson: '{"actions":[]}' },
		})
		expect(calls).toEqual([{ method: 'startRun', runId: 'run-1', runnerKey: 'test-runner-key' }])
	})

	test('a run that never reached the reconcile step leaves the field absent, not empty', async () => {
		const result: RelayResult = { lineCount: 1, status: { runId: 'run-1', state: 'failed', exitCode: 1, startedAt: 1 } }

		expect(await startRunOnRunner(fakeRunner([], result), job())).toEqual({ state: 'failed', exitCode: 1 })
	})

	test('a cancel presents the runner key', async () => {
		const calls: RunnerCall[] = []
		const runner = fakeRunner(calls, { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } })

		await cancelRunOnRunner(runner, 'run-1', 'test-runner-key')

		expect(calls).toEqual([{ method: 'cancelRun', runId: 'run-1', runnerKey: 'test-runner-key' }])
	})

	test('a cancel with no configured key never reaches the runner', async () => {
		const calls: RunnerCall[] = []
		const runner = fakeRunner(calls, { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } })

		await expect(cancelRunOnRunner(runner, 'run-1', undefined)).rejects.toThrow('FABRIKA_RUNNER_KEY')
		await expect(cancelRunOnRunner(runner, 'run-1', '')).rejects.toThrow('FABRIKA_RUNNER_KEY')
		expect(calls).toEqual([])
	})

	test('recovery reads the persisted terminal status as the outcome, IAM reconcile included', async () => {
		const calls: RunnerCall[] = []
		const persisted: RunnerStatus = {
			runId: 'run-1',
			state: 'succeeded',
			exitCode: 0,
			iamReconcile: { app: 'api', schemaJson: '{"actions":[]}' },
			startedAt: 1,
			finishedAt: 9,
		}
		const runner = fakeRunner(calls, { lineCount: 0, status: persisted }, persisted)

		expect(await recoverRunOnRunner(runner, 'run-1', 'test-runner-key')).toEqual({
			state: 'succeeded',
			exitCode: 0,
			iamReconcile: { app: 'api', schemaJson: '{"actions":[]}' },
		})
		expect(calls).toEqual([{ method: 'recoverRun', runId: 'run-1', runnerKey: 'test-runner-key' }])
	})

	test('runner results are parsed at the boundary: an old or malformed answer throws rather than failing the run', async () => {
		const wire = <T>(json: string): T => {
			const box: { v: T } = JSON.parse(`{"v":${json}}`)
			return box.v
		}
		const runner = (recovered: RunnerStatus | null, started: RelayResult): CloudflareRunnerService => ({
			startRun: async () => started,
			cancelRun: async () => {},
			recoverRun: async () => recovered,
		})
		const terminal: RelayResult = { lineCount: 0, status: { runId: 'run-1', state: 'succeeded', startedAt: 1 } }

		await expect(recoverRunOnRunner(runner(wire('"running"'), terminal), 'run-1', 'test-runner-key')).rejects.toThrow('malformed recovery status')
		await expect(recoverRunOnRunner(runner(wire('{"runId":"run-1","state":"done","startedAt":1}'), terminal), 'run-1', 'test-runner-key')).rejects
			.toThrow('malformed recovery status')
		expect(await recoverRunOnRunner(runner({ runId: 'run-1', state: 'deploying', startedAt: 1 }, terminal), 'run-1', 'test-runner-key')).toEqual({
			state: 'running',
		})
		expect(await recoverRunOnRunner(runner({ runId: 'run-1', state: 'failed', dryRun: true, startedAt: 1 }, terminal), 'run-1', 'test-runner-key'))
			.toEqual({ state: 'failed', dryRun: true })

		await expect(startRunOnRunner(runner(null, wire('{"status":"succeeded"}')), job())).rejects.toThrow('malformed run result')
		await expect(startRunOnRunner(runner(null, { lineCount: 0, status: { runId: 'run-1', state: 'deploying', startedAt: 1 } }), job())).rejects
			.toThrow('non-terminal run result')
	})

	test('recovery reports a run with no persisted status as still running, and needs the key', async () => {
		const calls: RunnerCall[] = []
		const runner = fakeRunner(calls, { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } })

		await expect(recoverRunOnRunner(runner, 'run-1', undefined)).rejects.toThrow('FABRIKA_RUNNER_KEY')
		expect(await recoverRunOnRunner(runner, 'run-1', 'test-runner-key')).toEqual({ state: 'running' })
		expect(calls).toEqual([{ method: 'recoverRun', runId: 'run-1', runnerKey: 'test-runner-key' }])
	})
})
