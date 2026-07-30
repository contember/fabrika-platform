import { describe, expect, test } from 'bun:test'
import type {
	AdoptDeploymentNamespaceRequest,
	AppEnvDto,
	CreateDeploymentNamespaceRequest,
	DeploymentNamespaceDetailDto,
	DeploymentNamespaceDto,
	PlanDeploymentNamespaceRequest,
	PlanDeploymentNamespaceResponse,
} from '../lib/api'

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
			publicOrigin: null,
			triggerRef: null,
			namespaceId: namespace.id,
			provider: 'harbor',
			target,
			artifact: { provider: 'harbor', version: 2, payload: { services: ['billing'] } },
			createdAt: 1,
		}
		const planRequest: PlanDeploymentNamespaceRequest = {
			id: namespace.id,
			env: namespace.env,
			preset: 'shared',
		}
		const plan: PlanDeploymentNamespaceResponse = {
			namespace: {
				id: create.id,
				env: create.env,
				target: create.target,
			},
			presentation: {
				preset: planRequest.preset,
				title: 'Shared production placement',
				facts: [{ label: 'Proxy', value: 'shared' }],
				instructions: ['Provision before assigning apps.'],
			},
		}
		const detail: DeploymentNamespaceDetailDto = {
			...namespace,
			presentation: plan.presentation,
		}

		expect(create.id).toBe(namespace.id)
		expect(adopt.exclusiveAppId).toBe('billing')
		expect(appEnv.namespaceId).toBe(namespace.id)
		expect(detail.presentation?.facts[0]?.value).toBe('shared')
	})
})
