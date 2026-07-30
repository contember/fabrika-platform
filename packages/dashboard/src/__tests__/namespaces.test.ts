import { describe, expect, test } from 'bun:test'
import type { AppEnvDto, DeploymentNamespaceDto } from '../lib/api'
import { compatibleNamespaces, namespaceAssignmentRequest } from '../lib/namespaces'

const envelope = { provider: 'zerops', version: 1, payload: {} }

const environment: AppEnvDto = {
	appId: 'notes',
	env: 'prod',
	domain: null,
	publicOrigin: 'http://notes.localhost:18081',
	triggerRef: null,
	namespaceId: null,
	provider: 'zerops',
	target: envelope,
	artifact: { provider: 'zerops', version: 2, payload: {} },
	createdAt: 1,
}

const namespace = (patch: Partial<DeploymentNamespaceDto> = {}): DeploymentNamespaceDto => ({
	id: 'apps-prod',
	env: 'prod',
	provider: 'zerops',
	exclusiveAppId: null,
	target: envelope,
	state: 'ready',
	lastError: null,
	createdAt: 1,
	...patch,
})

describe('compatibleNamespaces', () => {
	test('keeps only ready placements with matching env, provider, and ownership', () => {
		const result = compatibleNamespaces('notes', environment, [
			namespace(),
			namespace({ id: 'notes-prod', exclusiveAppId: 'notes' }),
			namespace({ id: 'other-prod', exclusiveAppId: 'other' }),
			namespace({ id: 'apps-stage', env: 'stage' }),
			namespace({ id: 'cf-prod', provider: 'cloudflare' }),
			namespace({ id: 'pending', state: 'pending' }),
		])

		expect(result.map((item) => item.id)).toEqual(['apps-prod', 'notes-prod'])
	})

	test('does not mutate or reorder the source list', () => {
		const source = [namespace({ id: 'b' }), namespace({ id: 'a' })]

		expect(compatibleNamespaces('notes', environment, source).map((item) => item.id)).toEqual(['b', 'a'])
		expect(source.map((item) => item.id)).toEqual(['b', 'a'])
	})

	test('assignment preserves opaque target and artifact envelopes by identity', () => {
		const request = namespaceAssignmentRequest(environment, 'apps-prod')

		expect(request.namespaceId).toBe('apps-prod')
		expect(request.publicOrigin).toBe(environment.publicOrigin)
		expect(request.target).toBe(environment.target)
		expect(request.artifact).toBe(environment.artifact)
	})
})
