import { createZeropsArtifactSourceDescriptor } from '@fabrika/provider-zerops'
import { describe, expect, test } from 'bun:test'
import { controlMcpSwitch, controlServiceDigest, ControlTableError } from '../../fabrika.service'
import type { Env } from '../env'
import { buildControlRpcDeps } from '../services'
import { zeropsControlProvider, zeropsGitHubSource, zeropsNamespaceProcessConfig } from '../zerops/provider'
import { createRuntime } from '../zerops/runtime'
import { createHarness } from './helpers/harness'
import { allowAllAuth } from './helpers/iam'

const PIN = {
	repository: { owner: 'example', name: 'platform' },
	commitSha: 'a'.repeat(40),
	descriptor: { ...await createZeropsArtifactSourceDescriptor('zerops:\n  - setup: proxy\n') },
}
const namespaceEnvironment = (): Record<string, string | undefined> => ({
	FABRIKA_ZEROPS_CLIENT_ID: 'client-1',
	FABRIKA_ZEROPS_PROXY_SOURCE_JSON: JSON.stringify(PIN),
	FABRIKA_ZEROPS_PROXY_IAM_URL: 'https://iam.example.test',
	FABRIKA_ZEROPS_PROXY_IAM_KEY: 'px_proxy_placeholder',
	FABRIKA_SERVICE_TABLE_DIGEST: controlServiceDigest({ mcp: false }),
})

const EXPECTED = {
	clientId: 'client-1',
	proxySource: PIN,
	iamUrl: 'https://iam.example.test',
	iamKey: 'px_proxy_placeholder',
}

describe('the Zerops namespace process configuration', () => {
	test('refuses malformed JSON without exposing its value and requires the variable', () => {
		const env = { ...namespaceEnvironment(), FABRIKA_ZEROPS_PROXY_SOURCE_JSON: 'credential-that-must-not-leak' }
		expect(() => zeropsNamespaceProcessConfig(env)).toThrow('must contain a valid immutable proxy source')
		expect(() => zeropsNamespaceProcessConfig({ ...env, FABRIKA_ZEROPS_PROXY_SOURCE_JSON: undefined })).toThrow(
			'FABRIKA_ZEROPS_PROXY_SOURCE_JSON is required',
		)
	})
	test('boots with no source service, and administers GitHub connections in process', async () => {
		const runtime = createRuntime({
			...namespaceEnvironment(),
			FABRIKA_CONTROL_DATABASE_URL: 'postgres://user:password@127.0.0.1:1/fabrika',
			FABRIKA_CONTROL_RUN_LOGS_BUCKET: 'run-logs',
			FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'access-key',
			FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: 'secret-key',
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			FABRIKA_IAM_RPC_KEY: 'iam-rpc-key-at-least-32-characters',
			FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
			ENVIRONMENT: 'stage',
		})
		expect(runtime.sourceConnection).toMatchObject({ provider: 'zerops' })
		expect(runtime.provider.source).toEqual({ binding: 'connection' })
		await runtime.shutdown()
	})

	test('the process provider republishes namespaces, so the registry hook is wired from its capability', async () => {
		const runtime = createRuntime({
			...namespaceEnvironment(),
			FABRIKA_CONTROL_DATABASE_URL: 'postgres://user:password@127.0.0.1:1/fabrika',
			FABRIKA_CONTROL_RUN_LOGS_BUCKET: 'run-logs',
			FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'access-key',
			FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: 'secret-key',
			FABRIKA_IAM_RPC_URL: 'http://iam:3000',
			FABRIKA_IAM_RPC_KEY: 'iam-rpc-key-at-least-32-characters',
			FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
			ENVIRONMENT: 'stage',
		})
		const deps = buildControlRpcDeps(runtime.env, runtime.provider, allowAllAuth())
		// Addressed by namespace id alone, and a namespace it cannot read is a refusal, never a silent no-op.
		expect(typeof deps.namespaceProxyChanged).toBe('function')
		await expect(deps.namespaceProxyChanged?.('nope')).rejects.toThrow()
		await runtime.shutdown()
	})

	test('maps every explicit environment variable to the provider contract', () => {
		expect(zeropsNamespaceProcessConfig(namespaceEnvironment())).toEqual(EXPECTED)
	})

	test('enables namespace lifecycle on the composed provider', () => {
		const harness = createHarness()
		const env: Env = {
			DB: harness.d1,
			REPOSITORIES: harness.repositories,
			ASSETS: { fetch: () => Promise.resolve(new Response()) },
			RUN_LOGS: {
				put: () => Promise.resolve(),
				get: () => Promise.resolve(null),
				delete: () => Promise.resolve(),
			},
			DEPLOY_QUEUE: { send: () => Promise.resolve() },
			WAIT_UNTIL: () => {},
			ENVIRONMENT: 'prod',
		}
		const provider = zeropsControlProvider(env, {
			...namespaceEnvironment(),
			FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
		}, zeropsGitHubSource(env))

		if (provider.namespaces === undefined) {
			throw new Error('Zerops provider did not enable namespace capabilities')
		}
		const normalized = provider.namespaces.normalize({
			id: 'apps-prod',
			env: 'prod',
			target: { provider: 'zerops', version: 1, payload: { proxySource: PIN } },
		})
		expect(normalized.target.payload).toEqual({
			projectName: 'apps-prod',
			corePackage: 'LIGHT',
			publicAccess: 'custom-domain',
			proxySource: PIN,
			managed: true,
			ready: false,
		})
		harness.sqlite.close()
	})

	for (
		const name of [
			'FABRIKA_ZEROPS_CLIENT_ID',
			'FABRIKA_ZEROPS_PROXY_SOURCE_JSON',
			'FABRIKA_ZEROPS_PROXY_IAM_URL',
			'FABRIKA_ZEROPS_PROXY_IAM_KEY',
		]
	) {
		test(`${name} is explicit and required`, () => {
			const source = namespaceEnvironment()
			source[name] = ' '
			expect(() => zeropsNamespaceProcessConfig(source)).toThrow(`${name} is required by the Zerops provider`)
		})
	}
})

describe('the one MCP switch: the table the proxy publishes', () => {
	const process = (overrides: Record<string, string | undefined>) => ({
		...namespaceEnvironment(),
		FABRIKA_CONTROL_DATABASE_URL: 'postgres://user:password@127.0.0.1:1/fabrika',
		FABRIKA_CONTROL_RUN_LOGS_BUCKET: 'run-logs',
		FABRIKA_CONTROL_RUN_LOGS_ACCESS_KEY_ID: 'access-key',
		FABRIKA_CONTROL_RUN_LOGS_SECRET_ACCESS_KEY: 'secret-key',
		FABRIKA_IAM_RPC_URL: 'http://iam:3000',
		FABRIKA_IAM_RPC_KEY: 'iam-rpc-key-at-least-32-characters',
		FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
		ENVIRONMENT: 'stage',
		...overrides,
	})

	test('refuses to start without the digest, or with one that names neither console table', () => {
		expect(() => createRuntime(process({ FABRIKA_SERVICE_TABLE_DIGEST: undefined }))).toThrow(ControlTableError)
		expect(() => createRuntime(process({ FABRIKA_SERVICE_TABLE_DIGEST: `sha256:${'0'.repeat(64)}` }))).toThrow(ControlTableError)
	})

	test('a published table with the oauth row serves MCP, and refuses to start without the origin its resource needs', async () => {
		expect(() => createRuntime(process({ FABRIKA_SERVICE_TABLE_DIGEST: controlServiceDigest({ mcp: true }) }))).toThrow('FABRIKA_CONTROL_DOMAIN')
		const on = createRuntime(
			process({ FABRIKA_SERVICE_TABLE_DIGEST: controlServiceDigest({ mcp: true }), FABRIKA_CONTROL_DOMAIN: 'console.example.com' }),
		)
		expect(on.mcp).not.toBeNull()
		await on.shutdown()
		const off = createRuntime(process({ FABRIKA_CONTROL_DOMAIN: 'console.example.com' }))
		expect(off.mcp).toBeNull()
		await off.shutdown()
	})

	test('the two tables have two digests', () => {
		expect(controlMcpSwitch(controlServiceDigest({ mcp: true }))).toBe(true)
		expect(controlMcpSwitch(controlServiceDigest({ mcp: false }))).toBe(false)
	})
})
