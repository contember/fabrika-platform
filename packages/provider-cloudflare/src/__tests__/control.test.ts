import type { ProviderDeployInput, ProviderEnvelope } from '@fabrika/provider-contract'
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

const deployInput = (): ProviderDeployInput => ({
	runId: 'run-1',
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
		runId: 'run-1',
	},
	signal: new AbortController().signal,
	events: {
		log: () => {},
		externalId: async () => {},
	},
})

describe('Cloudflare control provider', () => {
	test('normalizes registration and builds the runner request without persisting credentials', async () => {
		const jobs: CloudflareRunnerJob[] = []
		const externalIds: string[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
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
			runId: 'run-1',
			repoUrl: 'https://github.com/example/api.git?token=short-lived',
			ref: 'abc123',
			env: 'production',
			workerDir: 'worker',
			configPath: 'deploy.config.ts',
			stateNamespace: 'api-state',
			domain: 'api.example.com',
			dryRun: true,
			credentials: {
				CLOUDFLARE_ACCOUNT_ID: 'account-1',
				CLOUDFLARE_API_TOKEN: 'token-1',
				PROPUSTKA_URL: 'https://iam.example.com',
			},
			secrets: { API_KEY: 'secret' },
			vars: { FEATURE: 'on' },
			managedEnvironment: { FABRIKA_OPERATIONS_DSN: 'https://public@errors.test/1' },
			artifactUpload: input.artifactUpload,
		}])
		expect(externalIds).toEqual(['run-1'])
		expect(outcome).toEqual({ state: 'succeeded', exitCode: 0 })
		expect(isCloudflareRunnerJob(jobs[0])).toBe(true)
	})

	test('rejects another provider before registration is stored', () => {
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
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
			runId: 'run-1',
			repoUrl: 'https://github.com/example/api.git',
			ref: 'main',
			env: 'prod',
			credentials: {
				CLOUDFLARE_ACCOUNT_ID: 'account-1',
				CLOUDFLARE_API_TOKEN: 'token-1',
			},
		}
		expect(isCloudflareRunnerJob({ ...valid, dryRun: 'yes' })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, secrets: { API_KEY: 42 } })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, managedEnvironment: { FABRIKA_RELEASE: 42 } })).toBe(false)
		expect(isCloudflareRunnerJob({ ...valid, credentials: { ...valid.credentials, PROPUSTKA_URL: 42 } })).toBe(false)
	})
})
