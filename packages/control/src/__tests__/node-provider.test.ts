import { describe, expect, test } from 'bun:test'
import { zeropsControlProvider, zeropsNamespaceProcessConfig } from '../node/provider'
import { FakeRepoSource } from '../repo-source'
import { createHarness } from './helpers/harness'

const namespaceEnvironment = (): Record<string, string | undefined> => ({
	FABRIKA_ZEROPS_CLIENT_ID: 'client-1',
	FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT: 'https://github.com/contember/fabrika-platform',
	FABRIKA_ZEROPS_PROXY_IAM_URL: 'https://iam.example.test',
	FABRIKA_ZEROPS_PROXY_IAM_KEY: 'px_proxy_placeholder',
})

const EXPECTED = {
	clientId: 'client-1',
	proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
	iamUrl: 'https://iam.example.test',
	iamKey: 'px_proxy_placeholder',
}

describe('the Zerops namespace process configuration', () => {
	test('maps every explicit environment variable to the provider contract', () => {
		expect(zeropsNamespaceProcessConfig(namespaceEnvironment())).toEqual(EXPECTED)
	})

	test('no name uses the prefix Zerops reserves for itself', () => {
		// Verified live: `POST /service-stack/{id}/user-data` answers 400 userDataZeropsPrefixForbidden —
		// "Custom env variables with 'ZEROPS_' prefix are forbidden." A canonical name that starts with
		// `ZEROPS_` therefore cannot be written through the env API, which is the only channel a
		// per-installation secret has on Zerops (ADR-0004). This is what made the control plane
		// unconfigurable on the platform it was named after.
		for (const name of Object.keys(namespaceEnvironment())) {
			expect(name.startsWith('ZEROPS_'), `${name} uses the reserved prefix`).toBe(false)
		}
	})

	test('enables namespace lifecycle on the composed provider', () => {
		const harness = createHarness()
		const provider = zeropsControlProvider({
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
			REPO_EVENTS: new FakeRepoSource(),
			ENVIRONMENT: 'prod',
		}, {
			...namespaceEnvironment(),
			FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
			FABRIKA_ZEROPS_SOURCE_URL: 'http://source:3000',
			FABRIKA_ZEROPS_SOURCE_RPC_KEY: 'source-rpc-key-at-least-32-characters',
		})

		if (provider.namespaces === undefined) {
			throw new Error('Zerops provider did not enable namespace capabilities')
		}
		const normalized = provider.namespaces.normalize({
			id: 'apps-prod',
			env: 'prod',
			target: { provider: 'zerops', version: 1, payload: {} },
		})
		expect(normalized.target.payload).toEqual({
			projectName: 'apps-prod',
			corePackage: 'SERIOUS',
			publicAccess: 'custom-domain',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
			managed: true,
			ready: false,
		})
		harness.sqlite.close()
	})

	for (const name of ['FABRIKA_ZEROPS_SOURCE_URL', 'FABRIKA_ZEROPS_SOURCE_RPC_KEY']) {
		test(`${name} is required by the composed provider`, () => {
			const source: Record<string, string | undefined> = {
				...namespaceEnvironment(),
				FABRIKA_ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
				FABRIKA_ZEROPS_SOURCE_URL: 'http://source:3000',
				FABRIKA_ZEROPS_SOURCE_RPC_KEY: 'source-rpc-key-at-least-32-characters',
			}
			source[name] = ' '
			const harness = createHarness()
			expect(() =>
				zeropsControlProvider({
					DB: harness.d1,
					REPOSITORIES: harness.repositories,
					ASSETS: { fetch: () => Promise.resolve(new Response()) },
					RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
					DEPLOY_QUEUE: { send: () => Promise.resolve() },
					WAIT_UNTIL: () => {},
					REPO_EVENTS: new FakeRepoSource(),
					ENVIRONMENT: 'prod',
				}, source)
			).toThrow(`${name} is required by the Zerops provider`)
			harness.sqlite.close()
		})
	}

	for (
		const name of [
			'FABRIKA_ZEROPS_CLIENT_ID',
			'FABRIKA_ZEROPS_PROXY_BUILD_FROM_GIT',
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
