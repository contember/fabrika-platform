import { describe, expect, test } from 'bun:test'
import type { ControlRpcContract, DeploymentNamespaceDetailDto, DeploymentNamespaceDto, RemoveDeploymentNamespaceResponse } from '../index'

const detail = (): DeploymentNamespaceDetailDto => ({
	id: 'apps-prod',
	env: 'prod',
	provider: 'zerops',
	exclusiveAppId: null,
	target: { provider: 'zerops', version: 1, payload: { projectId: 'project-1' } },
	state: 'failed',
	lastError: 'zerops: project import failed (403)',
	lastErrorCode: 'insufficientPermissions',
	createdAt: 1,
	presentation: {
		preset: 'mid',
		title: 'Mid namespace',
		facts: [{ label: 'Project', value: 'apps-prod' }],
		instructions: [],
	},
})

describe('deployment namespace contract', () => {
	test('carries the failure class beside the redacted message', () => {
		const namespace: DeploymentNamespaceDto = detail()

		expect(namespace.lastErrorCode).toBe('insufficientPermissions')
		expect(namespace.lastError).not.toContain('insufficientPermissions:')
	})

	test('a row written before the codes existed carries a message and no code', () => {
		const legacy: DeploymentNamespaceDto = { ...detail(), lastError: 'namespace provision failed', lastErrorCode: null }

		expect(legacy.lastErrorCode).toBeNull()
	})

	test('removal answers with the whole removed row, which names the provider resources left behind', () => {
		const response: RemoveDeploymentNamespaceResponse = { removed: detail() }

		expect(response.removed.target.payload).toEqual({ projectId: 'project-1' })
		expect(response.removed.presentation?.facts).toEqual([{ label: 'Project', value: 'apps-prod' }])
	})

	test('the namespace router exposes removal alongside the lifecycle verbs', () => {
		const verbs: Array<keyof ControlRpcContract['namespaces']> = ['list', 'get', 'plan', 'create', 'adopt', 'reconcile', 'remove']

		expect(verbs).toContain('remove')
	})
})
