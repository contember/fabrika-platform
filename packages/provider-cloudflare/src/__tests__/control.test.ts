import { contractDigest, parseManagedEnvironment } from '@fabrika/auth-core'
import type {
	ControlProvider,
	ProviderApprovedAccess,
	ProviderDeployInput,
	ProviderEnvelope,
	ProviderRegistration,
	ProviderRegistrationInput,
} from '@fabrika/provider-contract'
import { abortableWait, ProviderInvocationAbort } from '@fabrika/provider-contract'
import { describeControlProviderConformance } from '@fabrika/provider-contract/conformance'
import { describe, expect, test } from 'bun:test'
import { schemaFromContract } from '../../../app/src/contract/platform'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import {
	cloudflareArtifact,
	cloudflareArtifactCodec,
	type CloudflareControlOptions,
	type CloudflareRunnerJob,
	cloudflareStoredTargetCodec,
	createCloudflareControlProvider,
} from '..'
import { checkoutRelativeDirectory, cloudflareRunnerJobSchema, type CloudflareRunRecovery } from '../control'
import { splitManagedEnvironment } from '../managed-secrets'
import type { RunnerIamReconcile } from '../runner-protocol'
import { PUBLISHED_PRERELEASES } from './published-prereleases'

const normalizeRegistration = (provider: ControlProvider, input: ProviderRegistrationInput): ProviderRegistration => {
	if (provider.normalizeRegistration === undefined) throw new Error('the Cloudflare provider normalizes registrations')
	return provider.normalizeRegistration(input)
}

const envelope = <T>(codec: { version: number; encode(value: T): ProviderEnvelope['payload'] }, value: T): ProviderEnvelope => ({
	provider: 'cloudflare',
	version: codec.version,
	payload: codec.encode(value),
})

/** The IAM schema the executor compiled from the checkout; Control never applies it (ADR-0050). */
const reported = (schemaJson: string): RunnerIamReconcile => ({ app: 'api', schemaJson })

/** The contract Control approved for the environment: its schema is the one IAM gets. */
const APPROVED = {
	contract: notesArtifact,
	contractDigest: contractDigest(notesArtifact),
	schema: schemaFromContract(notesArtifact),
	checker: '0.9.0',
	framework: '0.9.0',
}

const RUN_ID = '0192f0c9-4d5e-7a10-9c3b-1f2e3d4c5b6a'
const COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const sourceOptions: Pick<CloudflareControlOptions, 'resolveSource'> = {
	resolveSource: async () => ({ commitSha: COMMIT_SHA }),
}

const deployInput = (): ProviderDeployInput => ({
	runId: RUN_ID,
	app: {
		id: 'api',
		source: {
			repoUrl: 'https://github.com/example/api.git',
			ref: COMMIT_SHA,
			workerDir: 'worker',
		},
	},
	environment: {
		appId: 'api',
		env: 'production',
		domain: 'api.example.com',
		publicOrigin: 'https://public.example.com',
		target: envelope(cloudflareStoredTargetCodec, { stateNamespace: 'api-state' }),
		artifact: envelope(cloudflareArtifactCodec, cloudflareArtifact('deploy.config.ts')),
		access: APPROVED,
	},
	secrets: { API_KEY: 'secret' },
	vars: { FEATURE: 'on' },
	managedEnvironment: parseManagedEnvironment({
		FABRIKA_OPERATIONS_DSN: 'https://public@errors.test/1',
		FABRIKA_RELEASE: null,
	}),
	dryRun: true,
	artifactUpload: {
		url: 'https://operations.example.com/api/artifacts/source-maps/',
		bearer: 'a'.repeat(64),
		appId: 'api',
		environment: 'production',
		serviceKey: 'default',
		release: `fabrika/api/production/default/${'b'.repeat(40)}`,
		runId: RUN_ID,
	},
	signal: new AbortController().signal,
	events: {
		log: () => {},
		externalId: async () => {},
		checkpoint: async () => {},
		boundary: async () => {},
	},
})

describe('Cloudflare control provider', () => {
	test('refuses to deploy a dev environment before any runner call', async () => {
		const calls: string[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			prepareClone: async (source) => {
				calls.push('prepareClone')
				return { repoUrl: source.repoUrl }
			},
			startRun: async () => {
				calls.push('startRun')
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})
		const input = deployInput()
		await expect(provider.deploy({ ...input, environment: { ...input.environment, kind: 'dev' } })).rejects.toThrow(
			'Cloudflare runs no dev environment',
		)
		expect(calls).toEqual([])
		expect(provider.devEnvironments).toBeUndefined()
	})

	test('serves the ops channel from the release that gets the composed row, and writes the key digests as a plain var', () => {
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async () => ({ state: 'succeeded' }),
			cancelRun: async () => {},
		})
		expect(provider.opsChannel?.(APPROVED)).toBe(true)
		expect(provider.opsChannel?.({ ...APPROVED, checker: '0.8.2', framework: '0.8.2' })).toBe(false)
		expect(provider.dataOperations?.(APPROVED)).toBe(true)
		expect(provider.dataOperations?.({ ...APPROVED, checker: '0.8.2', framework: '0.8.2' })).toBe(false)
		// A published 0.9.0 prerelease answers `inspect` and refuses `state` and `migrate`: its deploys stay plain, though
		// this platform's reader of its minor (`checker`) is newer.
		for (const framework of PUBLISHED_PRERELEASES) {
			expect(provider.opsChannel?.({ ...APPROVED, framework })).toBe(true)
			expect(provider.dataOperations?.({ ...APPROVED, framework })).toBe(false)
		}
		expect(provider.dataOperations?.({ ...APPROVED, framework: '0.9.0-dev.5' })).toBe(true)
		// An access approved before Control recorded the pin is the oldest release of its reader's minor.
		const { framework: _pin, ...unpinned } = APPROVED
		expect(provider.opsChannel?.(unpinned)).toBe(true)
		expect(provider.dataOperations?.(unpinned)).toBe(false)
		const digests = `sha256:${'a'.repeat(64)}`
		// A plain var lives in the generated config, so a deploy after a downgrade, which hands `null`, leaves it out.
		expect(splitManagedEnvironment(parseManagedEnvironment({ FABRIKA_OPS_KEY_DIGESTS: digests }))).toEqual({
			vars: { FABRIKA_OPS_KEY_DIGESTS: digests },
			secrets: {},
		})
		expect(splitManagedEnvironment(parseManagedEnvironment({ FABRIKA_OPS_KEY_DIGESTS: null }))).toEqual({ vars: {}, secrets: {} })
	})

	test('exposes immutable resolution with recorded identity and independently validates registration', async () => {
		const input = deployInput()
		const calls: unknown[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			resolveSource: async (resolution) => {
				calls.push(resolution)
				return { commitSha: COMMIT_SHA }
			},
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async () => ({ state: 'succeeded' }),
			cancelRun: async () => {},
		})
		if (provider.resolveSource === undefined) throw new Error('missing immutable resolver')
		const resolution = { ...input, expectedCommitSha: COMMIT_SHA, app: { ...input.app, source: { ...input.app.source, ref: 'refs/heads/main' } } }
		expect(await provider.resolveSource(resolution)).toEqual({ commitSha: COMMIT_SHA })
		expect(calls).toEqual([resolution])
		await expect(provider.resolveSource({ ...resolution, environment: { ...input.environment, appId: 'other' } })).rejects.toThrow(
			'Cloudflare environment belongs to app "other", expected "api"',
		)
		await expect(
			provider.resolveSource({ ...resolution, environment: { ...input.environment, artifact: { provider: 'cloudflare', version: 2, payload: {} } } }),
		)
			.rejects.toThrow('artifact schema version 2 is not supported by provider "cloudflare"')
		await expect(provider.deploy({ ...input, environment: { ...input.environment, target: { provider: 'other', version: 1, payload: {} } } }))
			.rejects.toThrow('target belongs to provider "other", expected "cloudflare"')
		expect(calls).toHaveLength(1)
	})

	test('clone authorization cannot retarget the selected non-dry commit and precedes external acceptance', async () => {
		const order: string[] = []
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			resolveSource: async () => {
				throw new Error('deploy must use the already selected source')
			},
			prepareClone: async () => {
				order.push('clone')
				return { repoUrl: 'https://github.com/example/api.git', ref: 'b'.repeat(40) }
			},
			startRun: async (job) => {
				order.push('start')
				jobs.push(job)
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})
		await provider.deploy({
			...input,
			dryRun: false,
			events: {
				...input.events,
				externalId: async () => {
					order.push('accepted')
				},
			},
		})
		expect(order).toEqual(['clone', 'accepted', 'start'])
		expect(jobs[0]?.ref).toBe(COMMIT_SHA)
		expect(cloudflareRunnerJobSchema.safeParse(jobs[0]).success).toBe(true)
	})

	test('mutable non-dry refs fail before clone authorization; dry previews retain their requested ref', async () => {
		const prepared: string[] = []
		const jobs: CloudflareRunnerJob[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			prepareClone: async (source) => {
				prepared.push(source.ref)
				return { repoUrl: source.repoUrl }
			},
			startRun: async (job) => {
				jobs.push(job)
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})
		const input = deployInput()
		for (const ref of ['main', 'refs/tags/v1', 'abc123', COMMIT_SHA.toUpperCase(), 'a'.repeat(64), `${COMMIT_SHA}\n`]) {
			await expect(provider.deploy({ ...input, dryRun: false, app: { ...input.app, source: { ...input.app.source, ref } } }))
				.rejects.toThrow('canonical 40-character commit SHA')
		}
		expect(prepared).toEqual([])
		expect(jobs).toEqual([])
		await provider.deploy({ ...input, app: { ...input.app, source: { ...input.app.source, ref: 'refs/tags/v1' } } })
		expect(prepared).toEqual(['refs/tags/v1'])
		expect(jobs[0]?.ref).toBe('refs/tags/v1')
		expect(jobs[0]?.dryRun).toBe(true)
	})

	for (const boundary of ['resolve', 'clone']) {
		for (const rejection of [false, true]) {
			test(`preserves the original abort object on ${boundary} ${rejection ? 'rejection' : 'completion'}`, async () => {
				const controller = new AbortController()
				const reason = new ProviderInvocationAbort('lease_lost')
				const effects: string[] = []
				const interrupt = async (): Promise<void> => {
					controller.abort(reason)
					if (rejection) throw new DOMException('replaced upstream abort', 'AbortError')
				}
				const provider = createCloudflareControlProvider({
					accountId: 'account',
					apiToken: 'token',
					runnerKey: 'key',
					resolveSource: async () => {
						if (boundary === 'resolve') await interrupt()
						return { commitSha: COMMIT_SHA }
					},
					prepareClone: async (source) => {
						if (boundary === 'clone') await interrupt()
						return { repoUrl: source.repoUrl }
					},
					startRun: async () => {
						effects.push('start')
						return { state: 'succeeded' }
					},
					cancelRun: async () => {
						effects.push('cancel')
					},
				})
				const input = deployInput()
				const invocation = {
					...input,
					signal: controller.signal,
					events: {
						...input.events,
						externalId: async () => {
							effects.push('accepted')
						},
					},
				}
				if (provider.resolveSource === undefined) throw new Error('missing resolver')
				await expect(boundary === 'resolve' ? provider.resolveSource(invocation) : provider.deploy(invocation)).rejects.toBe(reason)
				expect(effects).toEqual([])
			})
		}
	}

	test('startup errors remain ambiguous until the runner recovery gate fences late starts', async () => {
		let recovery: CloudflareRunRecovery = { state: 'running' }
		let unavailable = true
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			prepareClone: async (source) => source,
			startRun: async () => {
				throw new Error('startup RPC unavailable')
			},
			cancelRun: async () => {},
			recoverRun: async () => {
				if (unavailable) throw new Error('recovery RPC unavailable')
				return recovery
			},
		})
		await expect(provider.deploy(deployInput())).rejects.toThrow('startup RPC unavailable')
		if (provider.reconcile === undefined) throw new Error('missing recovery')
		const input = {
			runId: RUN_ID,
			externalId: RUN_ID,
			environment: deployInput().environment,
			signal: new AbortController().signal,
			checkpoint: async () => {},
		}
		await expect(provider.reconcile(input)).rejects.toThrow('recovery RPC unavailable')
		unavailable = false
		expect(await provider.reconcile(input)).toEqual({ state: 'running' })
		recovery = { state: 'failed', exitCode: 1 }
		expect(await provider.reconcile(input)).toEqual({ state: 'failed', exitCode: 1 })
	})
	for (const kind of ['cancel_requested', 'lease_lost']) {
		test(`${kind} interrupts an outstanding runner RPC without conflating lease loss with cancellation`, async () => {
			const entered = Promise.withResolvers<void>()
			const controller = new AbortController()
			let cancels = 0
			const provider = createCloudflareControlProvider({
				accountId: 'account',
				apiToken: 'token',
				runnerKey: 'key',
				...sourceOptions,
				prepareClone: async (source) => source,
				startRun: async () => {
					entered.resolve()
					return new Promise(() => {})
				},
				cancelRun: async () => {
					cancels++
				},
			})
			const deploying = provider.deploy({ ...deployInput(), signal: controller.signal })
			await entered.promise
			const reason = new ProviderInvocationAbort(kind === 'lease_lost' ? 'lease_lost' : 'cancel_requested')
			controller.abort(reason)
			await expect(deploying).rejects.toBe(reason)
			expect(cancels).toBe(kind === 'lease_lost' ? 0 : 1)
		})
	}

	test('reads the step boundary while the runner works, and a cancellation found there cancels the runner', async () => {
		const controller = new AbortController()
		const reason = new ProviderInvocationAbort('cancel_requested')
		let boundaries = 0
		let cancels = 0
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			sleep: (_ms, signal) => abortableWait(1, signal),
			prepareClone: async (source) => source,
			startRun: () => new Promise(() => {}),
			cancelRun: async () => {
				cancels++
			},
		})
		const input = deployInput()
		const deploying = provider.deploy({
			...input,
			signal: controller.signal,
			events: {
				...input.events,
				boundary: async () => {
					boundaries++
					if (boundaries < 3) return
					controller.abort(reason)
					throw reason
				},
			},
		})
		await expect(deploying).rejects.toBe(reason)
		await Bun.sleep(0)
		// The fourth read is the abort listener confirming the lease before it cancels the runner.
		expect(boundaries).toBe(4)
		expect(cancels).toBe(1)
	})

	test('a cancellation whose lease is lost before the runner cancel leaves the runner alone', async () => {
		const entered = Promise.withResolvers<void>()
		const controller = new AbortController()
		let cancels = 0
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			prepareClone: async (source) => source,
			startRun: async () => {
				entered.resolve()
				return new Promise(() => {})
			},
			cancelRun: async () => {
				cancels++
			},
		})
		const input = deployInput()
		const deploying = provider.deploy({
			...input,
			signal: controller.signal,
			events: { ...input.events, boundary: () => Promise.reject(new ProviderInvocationAbort('lease_lost')) },
		})
		await entered.promise
		const reason = new ProviderInvocationAbort('cancel_requested')
		controller.abort(reason)
		await expect(deploying).rejects.toBe(reason)
		await Bun.sleep(0)
		expect(cancels).toBe(0)
	})

	test('a runner that answers before the first boundary reads none', async () => {
		let boundaries = 0
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			prepareClone: async (source) => source,
			startRun: async () => ({ state: 'succeeded' }),
			cancelRun: async () => {},
		})
		const input = deployInput()
		await provider.deploy({
			...input,
			dryRun: true,
			events: {
				...input.events,
				boundary: async () => {
					boundaries++
				},
			},
		})
		expect(boundaries).toBe(0)
	})

	test('cancellation arriving during async source preparation cannot start the runner', async () => {
		const sourceReady = Promise.withResolvers<void>()
		const controller = new AbortController()
		let starts = 0
		let accepted = 0
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			prepareClone: async (source) => {
				await sourceReady.promise
				return source
			},
			startRun: async () => {
				starts++
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})
		const input = deployInput()
		const deploying = provider.deploy({
			...input,
			signal: controller.signal,
			events: {
				...input.events,
				externalId: async () => {
					accepted++
				},
			},
		})
		controller.abort(new ProviderInvocationAbort('cancel_requested'))
		sourceReady.resolve()
		await expect(deploying).rejects.toThrow('cancellation requested')
		expect(starts).toBe(0)
		expect(accepted).toBe(0)
	})

	test('failed cancellation RPC cannot be reported as settled', async () => {
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			prepareClone: async (source) => source,
			startRun: async () => ({ state: 'succeeded' }),
			cancelRun: async () => {
				throw new Error('destroy unavailable')
			},
		})
		if (provider.cancel === undefined) throw new Error('missing cancellation')
		await expect(provider.cancel({ runId: RUN_ID, externalId: RUN_ID, environment: deployInput().environment, signal: new AbortController().signal }))
			.rejects.toThrow('destroy unavailable')
	})

	test('lease loss interrupts a hanging cancellation RPC without claiming settlement', async () => {
		const controller = new AbortController()
		const entered = Promise.withResolvers<void>()
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			prepareClone: async (source) => source,
			startRun: async () => ({ state: 'succeeded' }),
			cancelRun: async () => {
				entered.resolve()
				await new Promise(() => {})
			},
		})
		if (provider.cancel === undefined) throw new Error('missing cancellation')
		const cancelling = provider.cancel({ runId: RUN_ID, externalId: RUN_ID, environment: deployInput().environment, signal: controller.signal })
		await entered.promise
		const reason = new ProviderInvocationAbort('lease_lost')
		controller.abort(reason)
		await expect(cancelling).rejects.toBe(reason)
	})
	test('passes caller cancellation through clone preparation and refuses a pre-aborted invocation', async () => {
		const observed: AbortSignal[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...sourceOptions,
			prepareClone: async (_source, signal) => {
				observed.push(signal)
				if (signal.aborted) throw new DOMException('private caller reason', 'AbortError')
				return new Promise((_resolve, reject) => {
					signal.addEventListener('abort', () => reject(new DOMException('private caller reason', 'AbortError')), { once: true })
				})
			},
			startRun: async () => ({ state: 'succeeded' }),
			cancelRun: async () => {},
		})
		const preAborted = new AbortController()
		preAborted.abort()
		const preError = await provider.deploy({ ...deployInput(), signal: preAborted.signal }).catch((error: unknown) => error)
		expect(preError).toBeInstanceOf(DOMException)
		expect(observed).toEqual([])

		const inFlight = new AbortController()
		const pending = provider.deploy({ ...deployInput(), signal: inFlight.signal })
		inFlight.abort()
		const inFlightError = await pending.catch((error: unknown) => error)
		expect(inFlightError).toBeInstanceOf(DOMException)
		expect(observed).toEqual([inFlight.signal])
	})

	test('normalizes registration and builds the runner request without persisting credentials', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const externalIds: string[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: `${source.repoUrl}?token=short-lived`, ref: 'different-ignored-ref' }),
			startRun: async (job) => {
				jobs.push(job)
				return { state: 'succeeded', exitCode: 0 }
			},
			cancelRun: async () => {},
		})
		const input = deployInput()
		const normalized = normalizeRegistration(provider, { app: input.app, environment: input.environment })
		const outcome = await provider.deploy({
			...input,
			environment: normalized.environment,
			events: {
				...input.events,
				externalId: async (id) => {
					externalIds.push(id)
				},
			},
		})

		expect(normalized.environment.target.payload).toEqual({ stateNamespace: 'api-state' })
		expect(normalized.environment.publicOrigin).toBe('https://public.example.com')
		expect(jobs).toEqual([{
			runId: RUN_ID,
			repoUrl: 'https://github.com/example/api.git?token=short-lived',
			ref: COMMIT_SHA,
			env: 'production',
			workerDir: 'worker',
			configPath: 'deploy.config.ts',
			stateNamespace: 'api-state',
			domain: 'api.example.com',
			approvedAccess: { kind: 'contract', contract: notesArtifact, contractDigest: APPROVED.contractDigest, framework: APPROVED.framework },
			dryRun: true,
			runnerKey: 'test-runner-key',
			credentials: {
				CLOUDFLARE_ACCOUNT_ID: 'account-1',
				CLOUDFLARE_API_TOKEN: 'token-1',
			},
			secrets: { API_KEY: 'secret' },
			vars: { FEATURE: 'on' },
			managedEnvironment: { FABRIKA_OPERATIONS_DSN: 'https://public@errors.test/1' },
			artifactUpload: input.artifactUpload,
		}])
		expect(externalIds).toEqual([RUN_ID])
		expect(outcome).toEqual({ state: 'succeeded', exitCode: 0 })
		expect(cloudflareRunnerJobSchema.safeParse(jobs[0]).success).toBe(true)
	})

	const recordingProvider = (jobs: CloudflareRunnerJob[]): ControlProvider =>
		createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async (job) => {
				jobs.push(job)
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})

	test('hands the runner the workload, mail, platform transport and token keys: the deploy writes them as Worker secrets (ADR-0065)', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		const handed = {
			FABRIKA_JOB_NIGHTLY_KEY: 'px_job',
			FABRIKA_WEBHOOK_BILLING_KEY: 'px_webhook',
			FABRIKA_EMAIL_RESEND_API_KEY: 're_private-key',
			FABRIKA_PLATFORM_MAIL_KEY: 'px_private-relay-key',
			FABRIKA_PLATFORM_MAIL_URL: 'http://control:3000',
			FABRIKA_TOKEN_KEYS: 'kid12345:private-secret',
			FABRIKA_APP_ORIGIN: 'https://demo.example',
		}
		await recordingProvider(jobs).deploy({ ...input, managedEnvironment: { ...input.managedEnvironment, ...parseManagedEnvironment(handed) } })
		expect(jobs[0]?.managedEnvironment).toMatchObject(handed)
		expect(cloudflareRunnerJobSchema.safeParse(jobs[0]).success).toBe(true)
	})

	test("hands the runner the pointer Control records, and a job's pointer the application would refuse does not validate (ADR-0070 §9)", async () => {
		const jobs: CloudflareRunnerJob[] = []
		const applicationObjects = { object: 'application-x', objects: ['application', 'rehearsal', 'application-x'] }
		await recordingProvider(jobs).deploy({ ...deployInput(), applicationObjects })
		expect(jobs[0]?.applicationObjects).toEqual(applicationObjects)
		expect(cloudflareRunnerJobSchema.safeParse(jobs[0]).success).toBe(true)
		await recordingProvider(jobs).deploy(deployInput())
		expect(jobs[1]).not.toHaveProperty('applicationObjects')
		const outside = { ...jobs[0], applicationObjects: { object: 'application-x', objects: ['application'] } }
		expect(cloudflareRunnerJobSchema.safeParse(outside).success).toBe(false)
	})

	test('an application on a framework before 0.9 keeps the stateless Worker: no hop secret, and what it cannot run is refused (ADR-0062)', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		const access = { ...APPROVED, checker: '0.8.1', framework: '0.8.1' }
		const environment = { ...input.environment, access }
		await recordingProvider(jobs).deploy({
			...input,
			environment,
			managedEnvironment: { ...input.managedEnvironment, ...parseManagedEnvironment({ FABRIKA_PROXY_SECRET: 'p'.repeat(43) }) },
		})
		expect(jobs[0]?.managedEnvironment?.['FABRIKA_PROXY_SECRET']).toBeUndefined()
		expect(jobs[0]?.approvedAccess?.framework).toBe('0.8.1')
		for (
			const [name, value] of [['FABRIKA_JOB_NIGHTLY_KEY', 'px_job'], ['FABRIKA_EMAIL_RESEND_API_KEY', 're_key'], ['FABRIKA_TOKEN_KEYS', 'kid:secret']]
		) {
			await expect(
				recordingProvider(jobs).deploy({
					...input,
					environment,
					managedEnvironment: { ...input.managedEnvironment, ...parseManagedEnvironment({ [name]: value }) },
				}),
			).rejects
				.toThrow('framework 0.8.1')
		}
		expect(jobs).toHaveLength(1)
	})

	test('an application on 0.9 gets the hop secret its object checks', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		const secret = 'p'.repeat(43)
		await recordingProvider(jobs).deploy({
			...input,
			managedEnvironment: { ...input.managedEnvironment, ...parseManagedEnvironment({ FABRIKA_PROXY_SECRET: secret }) },
		})
		expect(jobs[0]?.managedEnvironment?.['FABRIKA_PROXY_SECRET']).toBe(secret)
	})

	test('a key the deploy no longer writes is left out of the job, for the deploy to delete', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		await recordingProvider(jobs).deploy({
			...input,
			managedEnvironment: { ...input.managedEnvironment, ...parseManagedEnvironment({ FABRIKA_TOKEN_KEYS: null }) },
		})
		expect(jobs[0]?.managedEnvironment?.['FABRIKA_TOKEN_KEYS']).toBeUndefined()
	})

	test('refuses a procedure that may run past the object transaction limit before any runner call', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		const contract = {
			...notesArtifact,
			procedures: {
				'api.slow': { rate: { perClient: null, perCaller: null, perEndpoint: null, bytesPerHour: null }, challenge: null, timeoutMs: 25_001 },
			},
		}
		const access = { ...APPROVED, contract, contractDigest: contractDigest(contract) }
		await expect(recordingProvider(jobs).deploy({ ...input, environment: { ...input.environment, access } })).rejects.toThrow(
			'cloudflare: procedure `api.slow` runs up to 25001 ms, and a handler on Cloudflare runs at most 25000 ms',
		)
		expect(jobs).toEqual([])
	})

	test('an application on Postgres takes no handler cap: only the object SQLite holds a transaction with a time limit', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		const contract = {
			...notesArtifact,
			procedures: {
				'api.slow': { rate: { perClient: null, perCaller: null, perEndpoint: null, bytesPerHour: null }, challenge: null, timeoutMs: 25_001 },
			},
		}
		const access = { ...APPROVED, contract, contractDigest: contractDigest(contract), database: 'postgres' as const }
		await recordingProvider(jobs).deploy({ ...input, environment: { ...input.environment, access } })
		expect(jobs).toHaveLength(1)
	})

	test('refuses a job longer than one 14-minute segment before any runner call, only at a release that caps segments (ADR-0062)', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		const purge = notesArtifact.jobs['purgeDeleted']
		if (purge === undefined) throw new Error('the fixture has a job')
		const deployWith = (timeoutMs: number, framework: string) => {
			const contract = { ...notesArtifact, jobs: { purgeDeleted: { ...purge, timeoutMs } } }
			const access = { ...APPROVED, contract, contractDigest: contractDigest(contract), framework }
			return recordingProvider(jobs).deploy({ ...input, environment: { ...input.environment, access } })
		}
		await expect(deployWith(14 * 60_000 + 1, '0.9.0')).rejects.toThrow(
			'cloudflare: job `purgeDeleted` runs up to 840001 ms, and a job segment on Cloudflare runs at most 840000 ms',
		)
		expect(jobs).toEqual([])
		await deployWith(14 * 60_000, '0.9.0')
		await deployWith(14 * 60_000 + 1, '0.8.1')
		for (const framework of PUBLISHED_PRERELEASES) await deployWith(14 * 60_000 + 1, framework)
		expect(jobs.map((job) => job.approvedAccess?.framework)).toEqual(['0.9.0', '0.8.1', ...PUBLISHED_PRERELEASES])
	})

	test('refuses a file kind or a file collection that scans its uploads before any runner call: no scanner runs on Cloudflare', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		const attachments = notesArtifact.files['attachments']
		if (attachments === undefined) throw new Error('the fixture has a file collection')
		const cases = [
			[{ ...notesArtifact, fileKinds: { scans: { types: ['application/pdf'], maxBytes: 1024, scan: true } } }, 'file kind `scans`'],
			[{ ...notesArtifact, files: { attachments: { ...attachments, scan: true } } }, 'file collection `attachments`'],
		] as const
		for (const [contract, subject] of cases) {
			const access = { ...APPROVED, contract, contractDigest: contractDigest(contract) }
			await expect(recordingProvider(jobs).deploy({ ...input, environment: { ...input.environment, access } })).rejects.toThrow(
				`cloudflare: ${subject} scans its uploads (\`scan: true\`), and no scanner runs on Cloudflare yet`,
			)
		}
		expect(jobs).toEqual([])
	})

	test("the job names the application's pin as its release, never the newer reader; an access without one names its minor's floor", async () => {
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		const deployAs = (access: ProviderApprovedAccess) => recordingProvider(jobs).deploy({ ...input, environment: { ...input.environment, access } })
		for (const framework of PUBLISHED_PRERELEASES) await deployAs({ ...APPROVED, framework })
		const { framework: _pin, ...unpinned } = APPROVED
		await deployAs(unpinned)
		expect(jobs.map((job) => job.approvedAccess?.framework)).toEqual([...PUBLISHED_PRERELEASES, '0.9.0-0'])
	})

	test('refuses raw SQL before any runner call below the release that runs it on SQLite, and sends it from that release on', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		const contract = { ...notesArtifact, declared: { 'api.notes.report': { sql: 'read' as const, unscoped: {}, connect: [], issues: null } } }
		const deployAt = (framework: string) => {
			const access = { ...APPROVED, contract, contractDigest: contractDigest(contract), framework }
			return recordingProvider(jobs).deploy({ ...input, environment: { ...input.environment, access } })
		}
		for (const framework of ['0.8.1', ...PUBLISHED_PRERELEASES]) {
			await expect(deployAt(framework)).rejects.toThrow(
				'cloudflare: `api.notes.report` declares raw SQL (`ctx.sql`), which an application on Cloudflare runs from framework 0.9.0-dev.5 on',
			)
		}
		expect(jobs).toEqual([])
		await deployAt('0.9.0-dev.5')
		await deployAt('0.9.0')
		expect(jobs.map((job) => job.approvedAccess?.framework)).toEqual(['0.9.0-dev.5', '0.9.0'])
	})

	test("sends every Cloudflare deployment of Control's registry with the job", async () => {
		const jobs: CloudflareRunnerJob[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...sourceOptions,
			installationApps: async () => [{ app: 'api', env: 'production' }, { app: 'notes', env: 'prod' }],
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async (job) => {
				jobs.push(job)
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})
		await provider.deploy(deployInput())
		expect(jobs.map((job) => job.installationApps)).toEqual([['api@production', 'notes@prod']])
		expect(cloudflareRunnerJobSchema.safeParse(jobs[0]).success).toBe(true)
	})

	test('rejects another provider before registration is stored', () => {
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async () => ({ state: 'failed' }),
			cancelRun: async () => {},
		})
		const input = deployInput()
		expect(() =>
			normalizeRegistration(provider, {
				app: input.app,
				environment: {
					...input.environment,
					target: { provider: 'other', version: 1, payload: {} },
				},
			})
		).toThrow('expected "cloudflare"')
	})

	test('the application root Control reads the snapshot at is the directory the runner executes in', () => {
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async () => ({ state: 'failed' }),
			cancelRun: async () => {},
		})
		const root = (workerDir?: string) =>
			provider.applicationRoot?.({ repoUrl: 'https://github.com/example/api.git', ref: COMMIT_SHA, ...(workerDir === undefined ? {} : { workerDir }) })
		expect([root(), root('.'), root('./'), root('.//.')]).toEqual(['', '', '', ''])
		expect([root('apps/api/'), root('./apps//api')]).toEqual(['apps/api', 'apps/api'])
		expect([root('a/../b'), root('..'), root('/srv/app')]).toEqual([null, null, null])
		expect(checkoutRelativeDirectory(undefined)).toBe('')
	})

	test('rejects malformed optional runner fields', () => {
		const valid = {
			runId: RUN_ID,
			repoUrl: 'https://github.com/example/api.git',
			ref: COMMIT_SHA,
			env: 'prod',
			runnerKey: 'test-runner-key',
			credentials: {
				CLOUDFLARE_ACCOUNT_ID: 'account-1',
				CLOUDFLARE_API_TOKEN: 'token-1',
			},
			approvedAccess: { kind: 'contract', contract: notesArtifact, contractDigest: APPROVED.contractDigest },
		}
		expect(cloudflareRunnerJobSchema.safeParse(valid).success).toBe(true)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, dryRun: 'yes' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, secrets: { API_KEY: 42 } }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, managedEnvironment: { FABRIKA_RELEASE: 42 } }).success).toBe(false)
		// An IAM credential on the job is refused outright: it would reach the checkout's own build.
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, credentials: { ...valid.credentials, FABRIKA_IAM_PROVISIONING_KEY: 'px_admin' } }).success)
			.toBe(false)
		expect(
			cloudflareRunnerJobSchema.safeParse({ ...valid, credentials: { ...valid.credentials, FABRIKA_IAM_ISSUER: 'https://iam.example.com' } }).success,
		).toBe(false)
		// An earlier release's Control still sends `returnOrigins`; the runner drops it rather than refuse the job.
		const older = cloudflareRunnerJobSchema.safeParse({ ...valid, returnOrigins: ['https://api.example.com'] })
		expect(older.success && !('returnOrigins' in older.data)).toBe(true)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, domain: 'api.example.com', crossOrigins: ['https://partner.example.org'] }).success)
			.toBe(true)
		for (
			const crossOrigins of [
				['https://partner.example.org/'],
				['https://*.example.org'],
				['https://key@partner.example.org'],
				['https://partner.example.org', 'https://partner.example.org'],
				['https://api.example.com'],
				Array.from({ length: 17 }, (_, index) => `https://p${index}.example.org`),
			]
		) {
			expect(cloudflareRunnerJobSchema.safeParse({ ...valid, domain: 'API.example.com', crossOrigins }).success).toBe(false)
		}
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, operationsOrigin: 'https://ingest.example.com' }).success).toBe(true)
		for (const operationsOrigin of ['https://ingest.example.com/1', 'https://key@ingest.example.com', 'ftp://ingest.example.com', '']) {
			expect(cloudflareRunnerJobSchema.safeParse({ ...valid, operationsOrigin }).success).toBe(false)
		}
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, installationApps: ['notes@prod', 'api@production'] }).success).toBe(true)
		for (const id of ['notes', 'notes@prod@eu', '@prod', 'notes@', 'notes @prod']) {
			expect(cloudflareRunnerJobSchema.safeParse({ ...valid, installationApps: [id] }).success).toBe(false)
		}
		for (const ref of ['main', COMMIT_SHA.toUpperCase(), `${COMMIT_SHA}\n`, COMMIT_SHA.slice(1)]) {
			expect(cloudflareRunnerJobSchema.safeParse({ ...valid, ref }).success).toBe(false)
		}
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, ref: 'main', dryRun: true }).success).toBe(true)
	})

	test('rejects job values that would become an option, a path or a foreign host in the container', () => {
		const valid = {
			runId: RUN_ID,
			repoUrl: 'https://github.com/example/api.git',
			ref: COMMIT_SHA,
			env: 'prod',
			runnerKey: 'test-runner-key',
			credentials: { CLOUDFLARE_ACCOUNT_ID: 'account-1', CLOUDFLARE_API_TOKEN: 'token-1' },
			approvedAccess: { kind: 'contract', contract: notesArtifact, contractDigest: APPROVED.contractDigest },
		}
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, runId: 'run-1' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, repoUrl: 'ext::sh -c id' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, repoUrl: 'http://github.com/example/api.git' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, repoUrl: 'https://x-access-token:ghs_secret@github.com/example/api.git' }).success).toBe(
			true,
		)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, ref: '--upload-pack=x' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, ref: 'main branch' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, ref: '' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, dryRun: true, ref: 'refs/heads/release/1.0' }).success).toBe(true)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, env: 'Prod' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, env: '' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, workerDir: '../x' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, workerDir: '/opt/fabrika' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, workerDir: 'packages/worker' }).success).toBe(true)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, configPath: '../../opt/fabrika/fabrika.config.ts' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, configPath: 'deploy/fabrika.config.ts' }).success).toBe(true)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, domain: 'api.example.com' }).success).toBe(true)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, domain: '*.example.com' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, domain: '' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, runnerKey: '' }).success).toBe(false)
		// Absent is accepted at this boundary on purpose: `vozka-runner` re-checks the key itself and refuses.
		const { runnerKey: _omit, ...noKey } = valid
		expect(cloudflareRunnerJobSchema.safeParse(noKey).success).toBe(true)
		// (7) a newline survives the URL parser and would reach git's argv and the "Cloning …" line.
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, repoUrl: 'https://github.com/example/api.git\n--upload-pack=x' }).success).toBe(false)
	})

	test('the job carries the approved contract, and a reported schema does not change the outcome (ADR-0050)', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async (job) => {
				jobs.push(job)
				return { state: 'succeeded', iamReconcile: reported('{"scopes":[],"actions":[{"action":"*"}],"roles":{}}') }
			},
			cancelRun: async () => {},
		})
		const { environment: { access: _approved, ...environment }, ...input } = deployInput()
		const access = APPROVED
		const outcome = await provider.deploy({ ...input, dryRun: false, environment: { ...environment, access } })

		expect(outcome).toMatchObject({ state: 'succeeded' })
		// The runner deploys the proxy table and the digest from this, not from the checkout.
		expect(jobs[0]?.approvedAccess).toEqual({
			kind: 'contract',
			contract: notesArtifact,
			contractDigest: access.contractDigest,
			framework: access.framework,
		})
		expect(cloudflareRunnerJobSchema.safeParse(jobs[0]).success).toBe(true)
	})

	test('the runner boundary refuses a non-dry job without approved access, without a contract, or without a digest', () => {
		const job = {
			runId: RUN_ID,
			repoUrl: 'https://github.com/example/api.git',
			ref: COMMIT_SHA,
			env: 'prod',
			credentials: { CLOUDFLARE_ACCOUNT_ID: 'account-1', CLOUDFLARE_API_TOKEN: 'token-1' },
		}
		const digest = contractDigest(notesArtifact)
		expect(cloudflareRunnerJobSchema.safeParse(job).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...job, dryRun: true }).success).toBe(true)
		expect(
			cloudflareRunnerJobSchema.safeParse({ ...job, approvedAccess: { kind: 'contract', contract: notesArtifact, contractDigest: digest } }).success,
		)
			.toBe(true)
		// The digest is the application's own release's, which Control computed before it upcast the contract (ADR-0062).
		const upcast = { ...notesArtifact, endpoints: notesArtifact.endpoints.slice(0, 1) }
		expect(cloudflareRunnerJobSchema.safeParse({ ...job, approvedAccess: { kind: 'contract', contract: upcast, contractDigest: digest } }).success)
			.toBe(true)
		expect(
			cloudflareRunnerJobSchema.safeParse({ ...job, approvedAccess: { kind: 'contract', contract: notesArtifact, contractDigest: 'sha256:other' } })
				.success,
		)
			.toBe(false)
		expect(
			cloudflareRunnerJobSchema.safeParse({ ...job, approvedAccess: { kind: 'contract', contract: { endpoints: [] }, contractDigest: digest } }).success,
		)
			.toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...job, approvedAccess: { kind: 'artifact', contract: notesArtifact } }).success).toBe(false)
	})

	test('an application on Postgres gets no ops channel and no data operations, whatever its release', () => {
		const provider = recordingProvider([])
		const postgres = { ...APPROVED, database: 'postgres' as const }
		expect(provider.opsChannel?.(postgres)).toBe(false)
		expect(provider.dataOperations?.(postgres)).toBe(false)
		expect(provider.opsChannel?.(APPROVED)).toBe(true)
		expect(provider.dataOperations?.(APPROVED)).toBe(true)
	})

	test("validateAccess refuses Postgres below the release that serves it, and a database other than the published access's", () => {
		const validate = recordingProvider([]).validateAccess
		if (validate === undefined) throw new Error('the Cloudflare provider validates a candidate')
		const { environment: { access: _published, ...unpublished } } = deployInput()
		const postgres = { ...APPROVED, database: 'postgres' as const }
		// A first publication may choose either database.
		expect(() => validate({ environment: unpublished, access: postgres })).not.toThrow()
		expect(() => validate({ environment: unpublished, access: APPROVED })).not.toThrow()
		expect(() => validate({ environment: unpublished, access: { ...postgres, framework: '0.9.0-dev.9' } })).not.toThrow()
		for (const framework of ['0.9.0-dev.8', '0.8.2', ...PUBLISHED_PRERELEASES]) {
			expect(() => validate({ environment: unpublished, access: { ...postgres, framework } })).toThrow(
				`@fabrika/app ${framework} cannot run on Postgres through Hyperdrive`,
			)
		}
		// An access approved before Control recorded the pin reads as its minor's floor, below the gate.
		const { framework: _pin, ...unpinned } = postgres
		expect(() => validate({ environment: unpublished, access: unpinned })).toThrow('cannot run on Postgres through Hyperdrive')
		// The same database again is no change.
		expect(() => validate({ environment: { ...unpublished, access: postgres }, access: postgres })).not.toThrow()
		expect(() => validate({ environment: { ...unpublished, access: APPROVED }, access: APPROVED })).not.toThrow()
		expect(() => validate({ environment: { ...unpublished, access: APPROVED }, access: postgres })).toThrow(
			"environment `production` runs on its Durable Object's SQLite, and this commit chooses Postgres through Hyperdrive; an environment's database cannot change, so create a new environment",
		)
		expect(() => validate({ environment: { ...unpublished, access: postgres }, access: APPROVED })).toThrow(
			"runs on Postgres through Hyperdrive, and this commit chooses its Durable Object's SQLite",
		)
	})

	test('the job carries the database Control approved, refuses Postgres below its release before any runner call, and the boundary refuses another', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const input = deployInput()
		const postgres = { ...APPROVED, database: 'postgres' as const }
		await recordingProvider(jobs).deploy({ ...input, dryRun: false, environment: { ...input.environment, access: postgres } })
		expect(jobs[0]?.approvedAccess?.database).toBe('postgres')
		const parsed = cloudflareRunnerJobSchema.safeParse(jobs[0])
		expect(parsed.success && parsed.data.approvedAccess?.database).toBe('postgres')
		expect(cloudflareRunnerJobSchema.safeParse({ ...jobs[0], approvedAccess: { ...jobs[0]?.approvedAccess, database: 'mysql' } }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...jobs[0], approvedAccess: { ...jobs[0]?.approvedAccess, database: 'sqlite' } }).success).toBe(false)
		// An application on the object's SQLite sends no database.
		await recordingProvider(jobs).deploy({ ...input, dryRun: false })
		expect(jobs[1]?.approvedAccess === undefined ? 'missing' : 'database' in jobs[1].approvedAccess).toBe(false)
		await expect(
			recordingProvider(jobs).deploy({
				...input,
				dryRun: false,
				environment: { ...input.environment, access: { ...postgres, framework: '0.9.0-dev.8' } },
			}),
		).rejects.toThrow('@fabrika/app 0.9.0-dev.8 cannot run on Postgres through Hyperdrive')
		expect(jobs).toHaveLength(2)
	})

	test('a reconcile fails a run whose runner reported a schema for an environment Control approved nothing for', async () => {
		const logs: string[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async () => ({ state: 'failed' }),
			cancelRun: async () => {},
			recoverRun: async () => ({ state: 'succeeded', iamReconcile: reported('{"scopes":[],"actions":[],"roles":{}}') }),
		})
		if (provider.reconcile === undefined) throw new Error('missing recovery')
		const { access: _approved, ...environment } = deployInput().environment
		const outcome = await provider.reconcile({
			runId: RUN_ID,
			externalId: RUN_ID,
			environment,
			signal: new AbortController().signal,
			log: async (line: string) => void logs.push(line),
		})
		expect(outcome).toEqual({ state: 'failed' })
		expect(logs).toEqual(['reconcile-schema failed: reported access, but Control approved no access for this environment'])
	})

	const recoveringProvider = (recovery: CloudflareRunRecovery) =>
		createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async () => {
				throw new Error('a reconcile must not start a run')
			},
			cancelRun: async () => {},
			recoverRun: async () => recovery,
		})

	const reconcileInput = (logs: string[] = []) => ({
		runId: RUN_ID,
		externalId: RUN_ID,
		environment: deployInput().environment,
		signal: new AbortController().signal,
		checkpoint: async () => {},
		log: async (line: string) => {
			logs.push(line)
		},
	})

	test('a reconcile reports the outcome the runner persisted', async () => {
		const provider = recoveringProvider({
			state: 'succeeded',
			exitCode: 0,
			iamReconcile: reported('{"scopes":[],"actions":[{"action":"notes.read"}],"roles":{}}'),
		})
		if (provider.reconcile === undefined) throw new Error('missing recovery')

		expect(await provider.reconcile(reconcileInput())).toEqual({ state: 'succeeded', exitCode: 0 })
	})

	test('a reconcile of a run still in flight leaves it running', async () => {
		const provider = recoveringProvider({ state: 'running' })
		if (provider.reconcile === undefined) throw new Error('missing recovery')

		expect(await provider.reconcile(reconcileInput())).toEqual({ state: 'running' })
	})

	test('a dry status is projected dry with its artifact state, and an IAM report on it is refused', async () => {
		const dry = recoveringProvider({ state: 'succeeded', exitCode: 0, artifactState: 'not_applicable', dryRun: true })
		if (dry.reconcile === undefined) throw new Error('missing recovery')
		expect(await dry.reconcile(reconcileInput())).toEqual({ state: 'succeeded', exitCode: 0, artifactState: 'not_applicable', dryRun: true })

		const logs: string[] = []
		const reporting = recoveringProvider({
			state: 'succeeded',
			exitCode: 0,
			dryRun: true,
			iamReconcile: reported('{"scopes":[],"actions":[],"roles":{}}'),
		})
		if (reporting.reconcile === undefined) throw new Error('missing recovery')
		expect(await reporting.reconcile(reconcileInput(logs))).toEqual({ state: 'failed', dryRun: true })
		expect(logs).toEqual(['reconcile-schema refused: a dry run reported access'])
	})

	test("the job carries the environment's cross origins, and none when it lists none", async () => {
		const jobs: CloudflareRunnerJob[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async (job) => {
				jobs.push(job)
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})
		const input = deployInput()

		await provider.deploy({ ...input, environment: { ...input.environment, crossOrigins: ['https://partner.example.org'] } })
		expect(jobs[0]?.crossOrigins).toEqual(['https://partner.example.org'])
		expect(cloudflareRunnerJobSchema.safeParse(jobs[0]).success).toBe(true)
		await provider.deploy(input)
		expect(jobs[1]).not.toHaveProperty('crossOrigins')
		expect(jobs[1]).not.toHaveProperty('operationsOrigin')
		await provider.deploy({ ...input, environment: { ...input.environment, operationsOrigin: 'https://ingest.example.com' } })
		expect(jobs[2]?.operationsOrigin).toBe('https://ingest.example.com')
		expect(cloudflareRunnerJobSchema.safeParse(jobs[2]).success).toBe(true)
	})
})

describeControlProviderConformance('the Cloudflare control provider', {
	create: (hooks) => {
		const mutations: string[] = []
		const stops: string[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			// The runner's preview deploys nothing; any other job deploys the Worker.
			startRun: async (job) => {
				if (!job.dryRun) mutations.push(`start:${job.runId}`)
				hooks.accepted()
				return { state: 'succeeded' }
			},
			cancelRun: async (runId) => {
				stops.push(`cancel:${runId}`)
			},
		})
		const { dryRun: _dryRun, signal: _signal, events: _events, ...input } = deployInput()
		return { provider, input, credentials: ['token-1', 'test-runner-key'], mutations: () => mutations, stops: () => stops }
	},
})
