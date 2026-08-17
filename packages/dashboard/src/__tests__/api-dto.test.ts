import { describe, expect, test } from 'bun:test'
import type {
	AdoptDeploymentNamespaceRequest,
	AppEnvDto,
	CreateDeploymentNamespaceRequest,
	DeploymentNamespaceDetailDto,
	DeploymentNamespaceDto,
	GitHubSourceConnectionListResponse,
	GitHubSourceConnectionStatusDto,
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

describe('source connection API DTOs', () => {
	test('cover every browser-safe lifecycle state without a credential field', () => {
		const app = {
			id: 123,
			slug: 'acme-fabrika',
			htmlUrl: 'https://github.com/apps/acme-fabrika',
			public: false,
			owner: { login: 'acme', type: 'Organization' },
			permissions: { contents: 'read' },
			events: ['push'],
		}
		const states: readonly GitHubSourceConnectionStatusDto[] = [
			{ provider: 'zerops', kind: 'github-app', state: 'anonymous' },
			{ provider: 'legacy', kind: 'github-app', state: 'unavailable' },
			{ provider: 'zerops', kind: 'github-app', state: 'adoption-required' },
			{
				provider: 'zerops',
				kind: 'github-app',
				state: 'setup-pending',
				connectionId: 'connection-1',
				phase: 'awaiting-manifest-callback',
				continuePath: '/api/source/github/manifest/connection-1',
			},
			{
				provider: 'zerops',
				kind: 'github-app',
				state: 'installation-required',
				connectionId: 'connection-1',
				app,
				installationUrl: 'https://github.com/apps/acme-fabrika/installations/new',
			},
			{
				provider: 'zerops',
				kind: 'github-app',
				state: 'connected',
				connectionId: 'connection-1',
				app,
				installation: { id: 42, accountLogin: 'acme', repositorySelection: 'selected', verifiedRepositories: [{ owner: 'acme', name: 'api' }] },
			},
			{ provider: 'zerops', kind: 'github-app', state: 'repair-required', connectionId: 'connection-1', reason: 'credential-activation', app },
		]
		expect(states.map((state) => state.state)).toEqual([
			'anonymous',
			'unavailable',
			'adoption-required',
			'setup-pending',
			'installation-required',
			'connected',
			'repair-required',
		])
		const wire = JSON.stringify(states)
		for (const forbidden of ['privateKey', 'credentialBundle', 'webhookSecret', 'sourceRpcKey']) expect(wire).not.toContain(forbidden)

		const connected = states.find((state) => state.state === 'connected')
		const workflow = states.find((state) => state.state === 'setup-pending')
		if (connected?.state !== 'connected' || workflow?.state !== 'setup-pending') throw new Error('source fixtures are incomplete')
		const collection: GitHubSourceConnectionListResponse = {
			items: [connected],
			nextCursor: 'page-2',
			workflow,
		}
		expect(collection.items[0]?.connectionId).toBe('connection-1')
		expect(JSON.stringify(collection)).not.toContain('privateKey')
	})
})
