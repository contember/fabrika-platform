import {
	CLOUDFLARE_SOURCE_PROTOCOL,
	cloudflareArtifact,
	cloudflareArtifactCodec,
	type CloudflareRunnerJob,
	cloudflareStoredTargetCodec,
	createCloudflareControlProvider,
} from '@fabrika/provider-cloudflare'
import type { ProviderDeployInput, ProviderEnvelope } from '@fabrika/provider-contract'
import { ProviderInvocationAbort } from '@fabrika/provider-contract'
import type { RelayResult } from '@fabrika/runner-cloudflare'
import { describe, expect, jest, spyOn, test } from 'bun:test'
import {
	assertRunnerSourceProtocol,
	cancelRunOnRunner,
	cloudflareControlProvider,
	cloudflareIamControlOptions,
	type CloudflareRunnerService,
	controlEnv,
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
			assertRunnerSourceProtocol: async () => {},
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
	test('resolves the recorded commit or requested ref through the concrete adapter; missing runner admission refuses acceptance', async () => {
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
			const source = { ...input.app.source, ref: 'refs/heads/main', githubInstallationId: 99 }
			const selection = { ...input, app: { ...input.app, source }, expectedCommitSha: input.app.source.ref }
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

function fakeRunner(calls: RunnerCall[], result: RelayResult): CloudflareRunnerService {
	return {
		sourceProtocol: async () => CLOUDFLARE_SOURCE_PROTOCOL,
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
	ref: 'abcdef1234567890abcdef1234567890abcdef12',
	env: 'production',
	runnerKey: 'test-runner-key',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'account-1', CLOUDFLARE_API_TOKEN: 'token-1' },
})

describe('the Cloudflare runner port', () => {
	for (const lateSettlement of ['resolved', 'rejected']) {
		test(`a pending capability times out at 15 seconds before acceptance; a late ${lateSettlement} RPC is harmless`, async () => {
			jest.useFakeTimers()
			const entered = Promise.withResolvers<void>()
			const response = Promise.withResolvers<typeof CLOUDFLARE_SOURCE_PROTOCOL>()
			const effects: string[] = []
			const unhandled: unknown[] = []
			const onUnhandled = (error: unknown): void => {
				unhandled.push(error)
			}
			process.on('unhandledRejection', onUnhandled)
			const svc: CloudflareRunnerService = {
				...fakeRunner([], { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } }),
				sourceProtocol: async (...args) => {
					expect(args).toEqual(['test-runner-key'])
					entered.resolve()
					return response.promise
				},
			}
			const input = deployInput()
			const provider = createCloudflareControlProvider({
				accountId: 'account',
				apiToken: 'token',
				runnerKey: 'test-runner-key',
				resolveSource: async () => ({ commitSha: input.app.source.ref }),
				prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
				assertRunnerSourceProtocol: (signal) => assertRunnerSourceProtocol(svc, 'test-runner-key', signal),
				startRun: async () => {
					effects.push('start')
					return { state: 'succeeded' }
				},
				cancelRun: async () => {
					effects.push('cancel')
				},
			})
			let settled = false
			const deploying = provider.deploy({
				...input,
				events: {
					...input.events,
					externalId: async () => {
						effects.push('accepted')
					},
				},
			}).then(
				() => {
					settled = true
					return undefined
				},
				(error: unknown) => {
					settled = true
					return error
				},
			)
			try {
				await entered.promise
				jest.advanceTimersByTime(14_999)
				await Promise.resolve()
				expect(settled).toBe(false)
				jest.advanceTimersByTime(1)
				const error = await deploying
				if (!(error instanceof Error)) throw new Error('expected capability timeout rejection')
				expect(error.message).toBe('Cloudflare runner source protocol is unavailable or not supported')
				expect(effects).toEqual([])
				expect(jest.getTimerCount()).toBe(0)
				jest.useRealTimers()
				if (lateSettlement === 'resolved') response.resolve(CLOUDFLARE_SOURCE_PROTOCOL)
				else response.reject(new Error('late RPC failure contains private-runner-token'))
				await Bun.sleep(0)
				expect(effects).toEqual([])
				expect(unhandled).toEqual([])
			} finally {
				response.resolve(CLOUDFLARE_SOURCE_PROTOCOL)
				process.off('unhandledRejection', onUnhandled)
				jest.useRealTimers()
			}
		})
	}

	test('the original caller abort object takes precedence over a rejected deadline wait', async () => {
		jest.useFakeTimers()
		const response = Promise.withResolvers<typeof CLOUDFLARE_SOURCE_PROTOCOL>()
		const controller = new AbortController()
		const reason = new ProviderInvocationAbort('lease_lost')
		const removal = spyOn(controller.signal, 'removeEventListener')
		const svc: CloudflareRunnerService = {
			...fakeRunner([], { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } }),
			sourceProtocol: () => response.promise,
		}
		try {
			const waiting = assertRunnerSourceProtocol(svc, 'test-runner-key', controller.signal).catch((error: unknown) => error)
			jest.advanceTimersByTime(15_000)
			controller.abort(reason)
			expect(await waiting).toBe(reason)
			expect(jest.getTimerCount()).toBe(0)
			expect(removal.mock.calls).toHaveLength(1)
			expect(removal.mock.calls[0]?.[0]).toBe('abort')
		} finally {
			response.resolve(CLOUDFLARE_SOURCE_PROTOCOL)
			removal.mockRestore()
			jest.useRealTimers()
		}
	})

	for (const settlement of ['resolved', 'rejected', 'aborted']) {
		test(`capability ${settlement} removes its deadline and abort listener`, async () => {
			jest.useFakeTimers()
			const controller = new AbortController()
			const removal = spyOn(controller.signal, 'removeEventListener')
			const response = Promise.withResolvers<typeof CLOUDFLARE_SOURCE_PROTOCOL>()
			const svc: CloudflareRunnerService = {
				...fakeRunner([], { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } }),
				sourceProtocol: () => response.promise,
			}
			try {
				const waiting = assertRunnerSourceProtocol(svc, 'test-runner-key', controller.signal).catch((error: unknown) => error)
				expect(jest.getTimerCount()).toBe(1)
				if (settlement === 'resolved') response.resolve(CLOUDFLARE_SOURCE_PROTOCOL)
				if (settlement === 'rejected') response.reject(new Error('capability refused'))
				if (settlement === 'aborted') controller.abort(new ProviderInvocationAbort('cancel_requested'))
				await waiting
				expect(jest.getTimerCount()).toBe(0)
				expect(removal.mock.calls).toHaveLength(1)
				expect(removal.mock.calls[0]?.[0]).toBe('abort')
			} finally {
				response.resolve(CLOUDFLARE_SOURCE_PROTOCOL)
				removal.mockRestore()
				jest.useRealTimers()
			}
		})
	}

	test('source admission presents only the key and requires the exact protocol literal', async () => {
		const keys: string[] = []
		const svc = fakeRunner([], { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } })
		const signal = new AbortController().signal
		await assertRunnerSourceProtocol(
			{
				...svc,
				sourceProtocol: async (...args) => {
					expect(args).toEqual(['test-runner-key'])
					keys.push(args[0])
					return CLOUDFLARE_SOURCE_PROTOCOL
				},
			},
			'test-runner-key',
			signal,
		)
		expect(keys).toEqual(['test-runner-key'])
		const oldProtocol: typeof CLOUDFLARE_SOURCE_PROTOCOL = JSON.parse('"branch-v0"')
		await expect(assertRunnerSourceProtocol({ ...svc, sourceProtocol: async () => oldProtocol }, 'test-runner-key', signal))
			.rejects.toThrow('source protocol is unavailable or not supported')
		await expect(assertRunnerSourceProtocol(
			{
				...svc,
				sourceProtocol: async () => {
					throw new Error('unknown RPC method')
				},
			},
			'test-runner-key',
			signal,
		))
			.rejects.toThrow('source protocol is unavailable or not supported')
	})

	test('source admission without a key never calls the Worker', async () => {
		let calls = 0
		const svc: CloudflareRunnerService = {
			...fakeRunner([], { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } }),
			sourceProtocol: async () => {
				calls++
				return CLOUDFLARE_SOURCE_PROTOCOL
			},
		}
		for (const key of [undefined, '']) {
			await expect(assertRunnerSourceProtocol(svc, key, new AbortController().signal)).rejects.toThrow('FABRIKA_RUNNER_KEY')
		}
		expect(calls).toBe(0)
	})

	test('a pre-aborted source admission preserves its reason and sends no RPC', async () => {
		const controller = new AbortController()
		const reason = new ProviderInvocationAbort('lease_lost')
		controller.abort(reason)
		let calls = 0
		const svc: CloudflareRunnerService = {
			...fakeRunner([], { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } }),
			sourceProtocol: async () => {
				calls++
				return CLOUDFLARE_SOURCE_PROTOCOL
			},
		}
		await expect(assertRunnerSourceProtocol(svc, 'test-runner-key', controller.signal)).rejects.toBe(reason)
		expect(calls).toBe(0)
	})

	for (const settlement of ['pending', 'resolved', 'rejected']) {
		test(`source admission preserves the caller abort object while the RPC is ${settlement}`, async () => {
			const entered = Promise.withResolvers<void>()
			const response = Promise.withResolvers<typeof CLOUDFLARE_SOURCE_PROTOCOL>()
			const controller = new AbortController()
			const reason = new ProviderInvocationAbort('lease_lost')
			const svc = fakeRunner([], { lineCount: 0, status: { runId: 'run-1', state: 'failed', startedAt: 1 } })
			const waiting = assertRunnerSourceProtocol(
				{
					...svc,
					sourceProtocol: async () => {
						entered.resolve()
						return response.promise
					},
				},
				'test-runner-key',
				controller.signal,
			)
			await entered.promise
			controller.abort(reason)
			if (settlement === 'resolved') response.resolve(CLOUDFLARE_SOURCE_PROTOCOL)
			if (settlement === 'rejected') response.reject(new DOMException('upstream replacement', 'AbortError'))
			await expect(waiting).rejects.toBe(reason)
			response.resolve(CLOUDFLARE_SOURCE_PROTOCOL)
		})
	}

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
