import { describe, expect, test } from 'bun:test'
import type { AdoptDeploymentNamespaceRequest, AppEnvDto, CreateDeploymentNamespaceRequest, DeploymentNamespaceDto } from '../lib/api'

const target = {
	provider: 'harbor',
	version: 1,
	payload: { region: 'eu' },
}

describe('namespace API DTOs', () => {
	test('mirror namespace and app-environment assignment payloads', () => {
		const namespace: DeploymentNamespaceDto = {
			id: 'apps-prod',
			env: 'prod',
			provider: 'harbor',
			exclusiveAppId: null,
			target,
			state: 'ready',
			lastError: null,
			createdAt: 1,
		}
		const create: CreateDeploymentNamespaceRequest = {
			id: namespace.id,
			env: namespace.env,
			target,
		}
		const adopt: AdoptDeploymentNamespaceRequest = {
			env: namespace.env,
			exclusiveAppId: 'billing',
			target,
		}
		const appEnv: AppEnvDto = {
			appId: 'billing',
			env: 'prod',
			domain: null,
			triggerRef: null,
			namespaceId: namespace.id,
			provider: 'cloudflare',
			target: { provider: 'cloudflare', version: 1, payload: {} },
			artifact: { provider: 'cloudflare', version: 1, payload: { configPath: 'fabrika.config.ts' } },
			createdAt: 1,
		}

		expect(create.id).toBe(namespace.id)
		expect(adopt.exclusiveAppId).toBe('billing')
		expect(appEnv.namespaceId).toBe(namespace.id)
	})
})
