import {
	cloudflareArtifact,
	cloudflareArtifactCodec,
	type CloudflareRunnerJob,
	cloudflareStoredTargetCodec,
	createCloudflareControlProvider,
} from '@fabrika/provider-cloudflare'
import type { ProviderDeployInput, ProviderEnvelope } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { cloudflareIamControlOptions, resolveControlEnvironmentAliases } from '../platform-cf'

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
	},
})

describe('Cloudflare control environment aliases', () => {
	test('legacy-only IAM bindings reach queued jobs under canonical names', async () => {
		const env = resolveControlEnvironmentAliases({
			PROPUSTKA_URL: 'https://legacy-iam.example.test',
			PROPUSTKA_PROVISIONING_KEY: 'px_legacy-provisioning',
		})
		const jobs: CloudflareRunnerJob[] = []
		const provider = createCloudflareControlProvider({
			accountId: 'account-1',
			apiToken: 'token-1',
			...cloudflareIamControlOptions(env),
			resolveSource: async (source) => ({ repoUrl: source.repoUrl, ref: source.ref }),
			startRun: async (job) => {
				jobs.push(job)
				return { state: 'succeeded' }
			},
			cancelRun: async () => {},
		})

		expect(env).toMatchObject({
			FABRIKA_IAM_URL: 'https://legacy-iam.example.test',
			FABRIKA_IAM_PROVISIONING_KEY: 'px_legacy-provisioning',
		})

		await provider.deploy(deployInput())

		expect(jobs[0]?.credentials).toMatchObject({
			FABRIKA_IAM_URL: 'https://legacy-iam.example.test',
			FABRIKA_IAM_PROVISIONING_KEY: 'px_legacy-provisioning',
		})
		expect(jobs[0]?.credentials.PROPUSTKA_URL).toBeUndefined()
		expect(jobs[0]?.credentials.PROPUSTKA_PROVISIONING_KEY).toBeUndefined()
	})
})
