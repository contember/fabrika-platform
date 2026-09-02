import type { ProviderDeployInput, ProviderEnvelope } from '@fabrika/provider-contract'
import type { RunnerIamReconcile } from '@fabrika/runner-contract'
import { describe, expect, test } from 'bun:test'
import {
	cloudflareArtifact,
	cloudflareArtifactCodec,
	type CloudflareRunnerJob,
	cloudflareStoredTargetCodec,
	createCloudflareControlProvider,
	isCloudflareRunnerJob,
} from '..'

const envelope = <T>(codec: { version: number; encode(value: T): ProviderEnvelope['payload'] }, value: T): ProviderEnvelope => ({
	provider: 'cloudflare',
	version: codec.version,
	payload: codec.encode(value),
})

const RUN_ID = '0192f0c9-4d5e-7a10-9c3b-1f2e3d4c5b6a'

const deployInput = (): ProviderDeployInput => ({
	runId: RUN_ID,
	app: {
		id: 'api',
		source: {
			repoUrl: 'https://github.com/example/api.git',
			ref: 'refs/heads/main',
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
	test('passes caller cancellation through source resolution', async () => {
		const observed: AbortSignal[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			resolveSource: async (_source, signal) => {
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
		expect(observed[0]).toBe(preAborted.signal)

		const inFlight = new AbortController()
		const pending = provider.deploy({ ...deployInput(), signal: inFlight.signal })
		inFlight.abort()
		const inFlightError = await pending.catch((error: unknown) => error)
		expect(inFlightError).toBeInstanceOf(DOMException)
		expect(observed[1]).toBe(inFlight.signal)
	})

	test('normalizes registration and builds the runner request without persisting credentials', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const externalIds: string[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			propustkaUrl: 'https://iam.example.com',
			resolveSource: async (source) => ({ repoUrl: `${source.repoUrl}?token=short-lived`, ref: 'abc123' }),
			startRun: async (job) => {
				jobs.push(job)
				return { state: 'succeeded', exitCode: 0 }
			},
			cancelRun: async () => {},
		})
		const input = deployInput()
		const normalized = provider.normalizeRegistration({ app: input.app, environment: input.environment })
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
			ref: 'abc123',
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
		expect(isCloudflareRunnerJob(jobs[0])).toBe(true)
	})

	test('rejects another provider before registration is stored', () => {
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			resolveSource: async (source) => ({ repoUrl: source.repoUrl, ref: source.ref }),
			startRun: async () => ({ state: 'failed' }),
			cancelRun: async () => {},
		})
		const input = deployInput()
		expect(() =>
			provider.normalizeRegistration({
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
			ref: 'main',
			env: 'prod',
			runnerKey: 'test-runner-key',
			credentials: {
				CLOUDFLARE_ACCOUNT_ID: 'account-1',
				CLOUDFLARE_API_TOKEN: 'token-1',
			},
		}
		expect(isCloudflareRunnerJob(valid)).toBe(true)
		expect(isCloudflareRunnerJob({ ...valid, dryRun: 'yes' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, secrets: { API_KEY: 42 } })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, managedEnvironment: { FABRIKA_RELEASE: 42 } })).toBe(false)
		// An IAM credential on the job is refused outright: it would reach the checkout's own build.
		expect(isCloudflareRunnerJob({ ...valid, credentials: { ...valid.credentials, FABRIKA_IAM_PROVISIONING_KEY: 'px_admin' } })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, credentials: { ...valid.credentials, FABRIKA_IAM_ISSUER: 'https://iam.example.com' } })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, returnOrigins: ['https://api.example.com'] })).toBe(true)
		expect(isCloudflareRunnerJob({ ...valid, returnOrigins: 'https://api.example.com' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, returnOrigins: [42] })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, returnOrigins: [''] })).toBe(false)
	})

	test('rejects job values that would become an option, a path or a foreign host in the container', () => {
		const valid = {
			runId: RUN_ID,
			repoUrl: 'https://github.com/example/api.git',
			ref: 'main',
			env: 'prod',
			runnerKey: 'test-runner-key',
			credentials: { CLOUDFLARE_ACCOUNT_ID: 'account-1', CLOUDFLARE_API_TOKEN: 'token-1' },
		}
		expect(isCloudflareRunnerJob({ ...valid, runId: 'run-1' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, repoUrl: 'ext::sh -c id' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, repoUrl: 'http://github.com/example/api.git' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, repoUrl: 'https://x-access-token:ghs_secret@github.com/example/api.git' })).toBe(true)
		expect(isCloudflareRunnerJob({ ...valid, ref: '--upload-pack=x' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, ref: 'main branch' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, ref: '' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, ref: 'refs/heads/release/1.0' })).toBe(true)
		expect(isCloudflareRunnerJob({ ...valid, env: 'Prod' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, env: '' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, workerDir: '../x' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, workerDir: '/opt/fabrika' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, workerDir: 'packages/worker' })).toBe(true)
		expect(isCloudflareRunnerJob({ ...valid, configPath: '../../opt/fabrika/fabrika.config.ts' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, configPath: 'deploy/fabrika.config.ts' })).toBe(true)
		expect(isCloudflareRunnerJob({ ...valid, domain: 'api.example.com' })).toBe(true)
		expect(isCloudflareRunnerJob({ ...valid, domain: '*.example.com' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, domain: '' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, runnerKey: '' })).toBe(false)
		// Absent is accepted at this boundary on purpose: `vozka-runner` re-checks the key itself and refuses.
		const { runnerKey: _omit, ...noKey } = valid
		expect(isCloudflareRunnerJob(noKey)).toBe(true)
		// (7) a newline survives the URL parser and would reach git's argv and the "Cloning …" line.
		expect(isCloudflareRunnerJob({ ...valid, repoUrl: 'https://github.com/example/api.git\n--upload-pack=x' })).toBe(false)
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
			resolveSource: async (source) => ({ repoUrl: source.repoUrl, ref: source.ref }),
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
			resolveSource: async (source) => ({ repoUrl: source.repoUrl, ref: source.ref }),
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
			resolveSource: async (source) => ({ repoUrl: source.repoUrl, ref: source.ref }),
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
			resolveSource: async (source) => ({ repoUrl: source.repoUrl, ref: source.ref }),
			startRun: async () => ({ state: 'succeeded', iamReconcile: reconcile }),
			cancelRun: async () => {},
		})
		expect(await provider.deploy({ ...deployInput(), dryRun: false })).toMatchObject({ state: 'succeeded' })

		expect(calls).toEqual([])
	})

	test('carries the control plane return origins to the runner', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			runnerKey: 'test-runner-key',
			resolveSource: async (source) => ({ repoUrl: source.repoUrl, ref: source.ref }),
			startRun: async (job) => {
				jobs.push(job)
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})
		const input = deployInput()

		await provider.deploy({ ...input, returnOrigins: ['https://api.example.com', 'https://stage.api.example.com'] })
		expect(jobs[0]?.returnOrigins).toEqual(['https://api.example.com', 'https://stage.api.example.com'])
		expect(isCloudflareRunnerJob(jobs[0])).toBe(true)

		// No projected set → the field is absent, so the runner never asks IAM to change anything.
		await provider.deploy(input)
		expect(jobs[1]).not.toHaveProperty('returnOrigins')
	})
})
