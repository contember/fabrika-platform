import {
	cloudflareArtifact,
	cloudflareArtifactCodec,
	type CloudflareRunnerJob,
	cloudflareStoredTargetCodec,
	createCloudflareControlProvider,
} from '@fabrika/provider-cloudflare'
import type { ProviderDeployInput, ProviderEnvelope } from '@fabrika/provider-contract'
import type { RelayResult } from '@fabrika/runner-cloudflare'
import { describe, expect, test } from 'bun:test'
import { cancelRunOnRunner, cloudflareIamControlOptions, type CloudflareRunnerService, startRunOnRunner } from '../platform-cf'

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
			ref: 'refs/heads/main',
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
			resolveSource: async (source) => ({ repoUrl: source.repoUrl, ref: source.ref }),
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

// The runner port. vozka-runner refuses any RPC that does not present FABRIKA_RUNNER_KEY, so both
// directions are pinned here: the key control sends on a cancel, and the terminal outcome it reads
// back — the executor's compiled IAM reconcile rides on the status, because core, not the untrusted
// container, is what applies it with the IAM admin key.

interface RunnerCall {
	readonly method: 'startRun' | 'cancelRun' | 'recoverRun'
	readonly runId: string
	readonly runnerKey: string | undefined
}

function fakeRunner(calls: RunnerCall[], result: RelayResult): CloudflareRunnerService {
	return {
		startRun: async (job) => {
			calls.push({ method: 'startRun', runId: job.runId, runnerKey: job.runnerKey })
			return result
		},
		cancelRun: async (runId, runnerKey) => {
			calls.push({ method: 'cancelRun', runId, runnerKey })
			return true
		},
		recoverRun: async (runId, runnerKey) => {
			calls.push({ method: 'recoverRun', runId, runnerKey })
			return 'running'
		},
	}
}

const job = (): CloudflareRunnerJob => ({
	runId: 'run-1',
	repoUrl: 'https://github.com/example/api.git',
	ref: 'refs/heads/main',
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
})
