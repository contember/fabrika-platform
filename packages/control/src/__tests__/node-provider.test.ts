import { describe, expect, test } from 'bun:test'
import { zeropsControlProvider, zeropsNamespaceProcessConfig } from '../node/provider'
import { createHarness } from './helpers/harness'

const namespaceEnvironment = (): Record<string, string | undefined> => ({
	ZEROPS_CLIENT_ID: 'client-1',
	ZEROPS_PROXY_BUILD_FROM_GIT: 'https://github.com/contember/fabrika-platform',
	ZEROPS_PROXY_IAM_URL: 'https://iam.example.test',
	ZEROPS_PROXY_IAM_KEY: 'px_proxy_placeholder',
})

describe('the Zerops namespace process configuration', () => {
	test('maps every explicit environment variable to the provider contract', () => {
		expect(zeropsNamespaceProcessConfig(namespaceEnvironment())).toEqual({
			clientId: 'client-1',
			proxyBuildFromGit: 'https://github.com/contember/fabrika-platform',
			iamUrl: 'https://iam.example.test',
			iamKey: 'px_proxy_placeholder',
		})
	})

	test('enables namespace lifecycle on the composed provider', () => {
		const harness = createHarness()
		const provider = zeropsControlProvider({
			DB: harness.d1,
			ASSETS: { fetch: () => Promise.resolve(new Response()) },
			RUN_LOGS: {
				put: () => Promise.resolve(),
				get: () => Promise.resolve(null),
				delete: () => Promise.resolve(),
			},
			DEPLOY_QUEUE: { send: () => Promise.resolve() },
			ENVIRONMENT: 'prod',
			DEV: 'true',
		}, {
			...namespaceEnvironment(),
			ZEROPS_ACCESS_TOKEN: 'zt-placeholder',
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

	for (
		const name of [
			'ZEROPS_CLIENT_ID',
			'ZEROPS_PROXY_BUILD_FROM_GIT',
			'ZEROPS_PROXY_IAM_URL',
			'ZEROPS_PROXY_IAM_KEY',
		]
	) {
		test(`${name} is explicit and required`, () => {
			const source = namespaceEnvironment()
			source[name] = ' '
			expect(() => zeropsNamespaceProcessConfig(source)).toThrow(`${name} is required by the Zerops provider`)
		})
	}
})
