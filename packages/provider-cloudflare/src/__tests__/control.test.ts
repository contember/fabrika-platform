import { ReconcileSchemaError } from '@fabrika/auth'
import type {
	ControlProvider,
	ProviderDeployInput,
	ProviderEnvelope,
	ProviderRegistration,
	ProviderRegistrationInput,
} from '@fabrika/provider-contract'
import { ProviderInvocationAbort } from '@fabrika/provider-contract'
import type { RunnerIamReconcile } from '@fabrika/runner-contract'
import { describe, expect, test } from 'bun:test'
import {
	cloudflareArtifact,
	cloudflareArtifactCodec,
	type CloudflareControlOptions,
	type CloudflareRunnerJob,
	cloudflareStoredTargetCodec,
	createCloudflareControlProvider,
} from '..'
import { cloudflareRunnerJobSchema, type CloudflareRunRecovery } from '../control'

const normalizeRegistration = (provider: ControlProvider, input: ProviderRegistrationInput): ProviderRegistration => {
	if (provider.normalizeRegistration === undefined) throw new Error('the Cloudflare provider normalizes registrations')
	return provider.normalizeRegistration(input)
}

const envelope = <T>(codec: { version: number; encode(value: T): ProviderEnvelope['payload'] }, value: T): ProviderEnvelope => ({
	provider: 'cloudflare',
	version: codec.version,
	payload: codec.encode(value),
})

const RUN_ID = '0192f0c9-4d5e-7a10-9c3b-1f2e3d4c5b6a'
const COMMIT_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const sourceOptions: Pick<CloudflareControlOptions, 'resolveSource' | 'assertRunnerSourceProtocol'> = {
	resolveSource: async () => ({ commitSha: COMMIT_SHA }),
	assertRunnerSourceProtocol: async () => {},
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
	},
	secrets: { API_KEY: 'secret' },
	vars: { FEATURE: 'on' },
	managedEnvironment: {
		FABRIKA_OPERATIONS_DSN: 'https://public@errors.test/1',
		FABRIKA_RELEASE: null,
	},
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
	},
})

describe('Cloudflare control provider', () => {
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

	test('clone authorization cannot retarget the selected non-dry commit and admission precedes external acceptance', async () => {
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
			assertRunnerSourceProtocol: async () => {
				order.push('admission')
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
		expect(order).toEqual(['clone', 'admission', 'accepted', 'start'])
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

	test('an old Worker capability refusal cannot record external acceptance or submit a job', async () => {
		const effects: string[] = []
		const input = deployInput()
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			assertRunnerSourceProtocol: async () => {
				throw new Error('unknown RPC method')
			},
			startRun: async () => {
				effects.push('start')
				return { state: 'succeeded' }
			},
			cancelRun: async () => {
				effects.push('cancel')
			},
		})
		await expect(provider.deploy({
			...input,
			events: {
				...input.events,
				externalId: async () => {
					effects.push('accepted')
				},
			},
		}))
			.rejects.toThrow('unknown RPC method')
		expect(effects).toEqual([])
	})

	for (const boundary of ['resolve', 'clone', 'admission']) {
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
					assertRunnerSourceProtocol: async () => {
						if (boundary === 'admission') await interrupt()
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

	test('lease loss interrupts an outstanding admission probe without external cancellation', async () => {
		const entered = Promise.withResolvers<void>()
		const controller = new AbortController()
		const reason = new ProviderInvocationAbort('lease_lost')
		const effects: string[] = []
		const input = deployInput()
		const provider = createCloudflareControlProvider({
			accountId: 'account',
			apiToken: 'token',
			runnerKey: 'key',
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			assertRunnerSourceProtocol: async () => {
				entered.resolve()
				await new Promise(() => {})
			},
			startRun: async () => {
				effects.push('start')
				return { state: 'succeeded' }
			},
			cancelRun: async () => {
				effects.push('cancel')
			},
		})
		const deploying = provider.deploy({
			...input,
			signal: controller.signal,
			events: {
				...input.events,
				externalId: async () => {
					effects.push('accepted')
				},
			},
		})
		await entered.promise
		controller.abort(reason)
		await expect(deploying).rejects.toBe(reason)
		expect(effects).toEqual([])
	})

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
			propustkaUrl: 'https://iam.example.com',
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
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, returnOrigins: ['https://api.example.com'] }).success).toBe(true)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, returnOrigins: 'https://api.example.com' }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, returnOrigins: [42] }).success).toBe(false)
		expect(cloudflareRunnerJobSchema.safeParse({ ...valid, returnOrigins: [''] }).success).toBe(false)
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

	test("applies the reported schema with the control plane's own key, return origins beside it", async () => {
		const calls: Array<{ url: string; app: string; schema: unknown; returnOrigins?: readonly string[]; adminKey?: string }> = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			propustkaUrl: 'https://iam.example.com',
			propustkaProvisioningKey: 'px_admin',
			reconcileSchema: async (input) => {
				calls.push({
					url: input.url,
					app: input.app,
					schema: input.schema,
					...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }),
					adminKey: input.adminKey,
				})
			},
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async () => ({
				state: 'succeeded',
				iamReconcile: { app: 'api', schemaJson: '{"scopes":[{"type":"team"}],"actions":[{"action":"notes.read"}],"roles":{}}' },
			}),
			cancelRun: async () => {},
		})

		const outcome = await provider.deploy({ ...deployInput(), dryRun: false, returnOrigins: ['https://api.example.com'] })

		expect(outcome).toMatchObject({ state: 'succeeded' })
		expect(calls).toEqual([{
			url: 'https://iam.example.com',
			app: 'api',
			schema: { scopes: [{ type: 'team' }], actions: [{ action: 'notes.read' }], roles: {} },
			returnOrigins: ['https://api.example.com'],
			adminKey: 'px_admin',
		}])
	})

	const reconcilingProvider = (iamReconcile: { app: string; schemaJson: string }, calls: string[], propustkaUrl = 'https://iam.example.com') =>
		createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			propustkaUrl,
			propustkaProvisioningKey: 'px_admin',
			reconcileSchema: async (input) => {
				calls.push(input.app)
			},
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async () => ({ state: 'succeeded', iamReconcile }),
			cancelRun: async () => {},
		})

	test('a run with no return origins calls the reconciler without `returnOrigins`', async () => {
		const calls: Array<{ app: string; hasReturnOrigins: boolean }> = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			propustkaUrl: 'https://iam.example.com',
			propustkaProvisioningKey: 'px_admin',
			reconcileSchema: async (input) => {
				calls.push({ app: input.app, hasReturnOrigins: input.returnOrigins !== undefined })
			},
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async () => ({ state: 'succeeded', iamReconcile: { app: 'api', schemaJson: '{"scopes":[],"actions":[],"roles":{}}' } }),
			cancelRun: async () => {},
		})

		await provider.deploy({ ...deployInput(), dryRun: false })
		expect(calls).toEqual([{ app: 'api', hasReturnOrigins: false }])
	})

	test('fails the run without touching IAM when the container reports another app', async () => {
		const calls: string[] = []
		const logs: string[] = []
		const input = deployInput()
		const outcome = await reconcilingProvider({ app: 'vozka', schemaJson: '{"scopes":[],"actions":[],"roles":{}}' }, calls).deploy({
			...input,
			dryRun: false,
			events: { ...input.events, log: (line) => logs.push(line) },
		})

		expect(outcome).toEqual({ state: 'failed' })
		expect(calls).toEqual([])
		expect(logs.join('\n')).toContain('reconcile-schema failed')
		expect(logs.join('\n')).toContain('"vozka"')
	})

	test('fails the run when the reported schema is malformed or oversized', async () => {
		const calls: string[] = []
		const malformed = await reconcilingProvider({ app: 'api', schemaJson: '{"scopes":' }, calls).deploy({ ...deployInput(), dryRun: false })
		expect(malformed).toEqual({ state: 'failed' })

		// Nothing validates the container's `/status` body on the way here, so the fields are typed but not proven.
		const logs: string[] = []
		const input = deployInput()
		const wireReport: RunnerIamReconcile = JSON.parse('{"app":"api","schemaJson":["{}"]}')
		const notAString = await reconcilingProvider(wireReport, calls).deploy({
			...input,
			dryRun: false,
			events: { ...input.events, log: (line) => logs.push(line) },
		})
		expect(notAString).toEqual({ state: 'failed' })
		expect(logs.join('\n')).toContain('is not a string')

		const wrongShape = await reconcilingProvider({ app: 'api', schemaJson: '{"scopes":[{}],"actions":[],"roles":{}}' }, calls).deploy({
			...deployInput(),
			dryRun: false,
		})
		expect(wrongShape).toEqual({ state: 'failed' })

		const oversized = JSON.stringify({ scopes: [{ type: 'x'.repeat(1024 * 1024) }], actions: [], roles: {} })
		const tooBig = await reconcilingProvider({ app: 'api', schemaJson: oversized }, calls).deploy({ ...deployInput(), dryRun: false })
		expect(tooBig).toEqual({ state: 'failed' })

		expect(calls).toEqual([])
	})

	test('never reconciles for a dry run, nor with no IAM configured', async () => {
		const calls: string[] = []
		const reconcile = { app: 'api', schemaJson: '{"scopes":[],"actions":[],"roles":{}}' }
		expect(await reconcilingProvider(reconcile, calls).deploy(deployInput())).toMatchObject({ state: 'succeeded' })

		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			reconcileSchema: async (input) => {
				calls.push(input.app)
			},
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async () => ({ state: 'succeeded', iamReconcile: reconcile }),
			cancelRun: async () => {},
		})
		expect(await provider.deploy({ ...deployInput(), dryRun: false })).toMatchObject({ state: 'succeeded' })

		expect(calls).toEqual([])
	})

	const recoveringProvider = (
		recovery: CloudflareRunRecovery,
		calls: Array<{ app: string; returnOrigins?: readonly string[] }>,
		iamFailure?: Error,
	) =>
		createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			propustkaUrl: 'https://iam.example.com',
			propustkaProvisioningKey: 'px_admin',
			reconcileSchema: async (input) => {
				calls.push({ app: input.app, ...(input.returnOrigins === undefined ? {} : { returnOrigins: input.returnOrigins }) })
				if (iamFailure !== undefined) throw iamFailure
			},
			...sourceOptions,
			prepareClone: async (source) => ({ repoUrl: source.repoUrl }),
			startRun: async () => {
				throw new Error('a reconcile must not start a run')
			},
			cancelRun: async () => {},
			recoverRun: async () => recovery,
		})

	const reconcileInput = (returnOrigins?: readonly string[], logs: string[] = []) => ({
		runId: RUN_ID,
		externalId: RUN_ID,
		environment: deployInput().environment,
		signal: new AbortController().signal,
		checkpoint: async () => {},
		log: async (line: string) => {
			logs.push(line)
		},
		...(returnOrigins === undefined ? {} : { returnOrigins }),
	})

	test('a reconcile applies the persisted outcome IAM reconcile once, with return origins, before reporting it terminal', async () => {
		const calls: Array<{ app: string; returnOrigins?: readonly string[] }> = []
		const provider = recoveringProvider({
			state: 'succeeded',
			exitCode: 0,
			iamReconcile: { app: 'api', schemaJson: '{"scopes":[],"actions":[{"action":"notes.read"}],"roles":{}}' },
		}, calls)
		if (provider.reconcile === undefined) throw new Error('missing recovery')

		expect(await provider.reconcile(reconcileInput(['https://api.example.com']))).toEqual({ state: 'succeeded', exitCode: 0 })
		expect(calls).toEqual([{ app: 'api', returnOrigins: ['https://api.example.com'] }])
	})

	test('a reconcile of a run still in flight applies nothing', async () => {
		const calls: Array<{ app: string }> = []
		const provider = recoveringProvider({ state: 'running' }, calls)
		if (provider.reconcile === undefined) throw new Error('missing recovery')

		expect(await provider.reconcile(reconcileInput())).toEqual({ state: 'running' })
		expect(calls).toEqual([])
	})

	test('a reconcile whose reported schema is invalid fails the run without touching IAM, and says why in the run log', async () => {
		const calls: Array<{ app: string }> = []
		const logs: string[] = []
		const provider = recoveringProvider({
			state: 'succeeded',
			exitCode: 0,
			artifactState: 'complete',
			iamReconcile: { app: 'vozka', schemaJson: '{"scopes":[],"actions":[],"roles":{}}' },
		}, calls)
		if (provider.reconcile === undefined) throw new Error('missing recovery')

		expect(await provider.reconcile(reconcileInput(undefined, logs))).toEqual({ state: 'failed', artifactState: 'complete' })
		expect(calls).toEqual([])
		expect(logs).toEqual(['reconcile-schema failed: reported an authz schema for app "vozka", expected "api"'])
	})

	test('an unavailable IAM keeps the run in flight for the next reconcile, and logs the reason', async () => {
		const calls: Array<{ app: string }> = []
		const logs: string[] = []
		const provider = recoveringProvider(
			{ state: 'succeeded', exitCode: 0, iamReconcile: { app: 'api', schemaJson: '{"scopes":[],"actions":[],"roles":{}}' } },
			calls,
			new Error('PUT /admin/apps/api/schema failed (503): unavailable'),
		)
		if (provider.reconcile === undefined) throw new Error('missing recovery')

		expect(await provider.reconcile(reconcileInput(undefined, logs))).toEqual({ state: 'running' })
		expect(calls).toEqual([{ app: 'api' }])
		expect(logs).toEqual(['reconcile-schema failed: PUT /admin/apps/api/schema failed (503): unavailable'])
	})

	test('an IAM refusal (4xx) fails the run instead of retrying it forever', async () => {
		const calls: Array<{ app: string }> = []
		const logs: string[] = []
		const provider = recoveringProvider(
			{ state: 'succeeded', exitCode: 0, iamReconcile: { app: 'api', schemaJson: '{"scopes":[],"actions":[],"roles":{}}' } },
			calls,
			new ReconcileSchemaError('PUT /admin/apps/api/schema failed (401): unauthorized', 401),
		)
		if (provider.reconcile === undefined) throw new Error('missing recovery')

		expect(await provider.reconcile(reconcileInput(undefined, logs))).toEqual({ state: 'failed' })
		expect(logs).toEqual(['reconcile-schema failed: PUT /admin/apps/api/schema failed (401): unauthorized'])
	})

	test('a dry status is projected dry with its artifact state, and an IAM report on it is refused', async () => {
		const calls: Array<{ app: string }> = []
		const dry = recoveringProvider({ state: 'succeeded', exitCode: 0, artifactState: 'not_applicable', dryRun: true }, calls)
		if (dry.reconcile === undefined) throw new Error('missing recovery')
		expect(await dry.reconcile(reconcileInput())).toEqual({ state: 'succeeded', exitCode: 0, artifactState: 'not_applicable', dryRun: true })

		const logs: string[] = []
		const reporting = recoveringProvider({
			state: 'succeeded',
			exitCode: 0,
			dryRun: true,
			iamReconcile: { app: 'api', schemaJson: '{"scopes":[],"actions":[],"roles":{}}' },
		}, calls)
		if (reporting.reconcile === undefined) throw new Error('missing recovery')
		expect(await reporting.reconcile(reconcileInput(undefined, logs))).toEqual({ state: 'failed', dryRun: true })
		expect(calls).toEqual([])
		expect(logs).toEqual(['reconcile-schema refused: a dry run reported an authz schema'])
	})

	test('carries the control plane return origins to the runner', async () => {
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

		await provider.deploy({ ...input, returnOrigins: ['https://api.example.com', 'https://stage.api.example.com'] })
		expect(jobs[0]?.returnOrigins).toEqual(['https://api.example.com', 'https://stage.api.example.com'])
		expect(cloudflareRunnerJobSchema.safeParse(jobs[0]).success).toBe(true)

		// No projected set → the field is absent, so the runner never asks IAM to change anything.
		await provider.deploy(input)
		expect(jobs[1]).not.toHaveProperty('returnOrigins')
	})
})
