import { describe, expect, jest, test } from 'bun:test'
import type { AppEnvDto, DeploymentNamespaceDetailDto, DeploymentNamespaceDto, DeploymentNamespaceState } from '../lib/api'
import {
	compatibleNamespaces,
	namespaceAssignmentRequest,
	namespaceFailure,
	retainedNamespaceResources,
	scheduleNamespacePoll,
} from '../lib/namespaces'

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
	lastErrorCode: null,
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
			namespace({ id: 'provisioning', state: 'provisioning' }),
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

describe('scheduleNamespacePoll', () => {
	test('follows a settling placement and stops once it is terminal', () => {
		const scheduled: number[] = []
		const schedule = (_callback: () => void, delayMs: number) => {
			scheduled.push(delayMs)
			return () => undefined
		}

		scheduleNamespacePoll('pending', () => undefined, schedule)
		scheduleNamespacePoll('provisioning', () => undefined, schedule)
		expect(scheduled).toEqual([2_000, 2_000])

		scheduleNamespacePoll('ready', () => undefined, schedule)
		scheduleNamespacePoll('failed', () => undefined, schedule)
		expect(scheduled).toEqual([2_000, 2_000])
	})

	test('keeps refreshing until the namespace settles, with no caller attached to the mutation', () => {
		jest.useFakeTimers()
		try {
			const states: DeploymentNamespaceState[] = ['pending', 'provisioning', 'ready']
			const schedule = (callback: () => void, delayMs: number) => {
				const timer = setTimeout(callback, delayMs)
				return () => clearTimeout(timer)
			}
			let index = 0
			let refreshes = 0
			let cancel = () => undefined
			const render = () => {
				cancel()
				cancel = scheduleNamespacePoll(states[index] ?? 'ready', () => {
					refreshes++
					index++
					render()
				}, schedule)
			}

			render()
			jest.advanceTimersByTime(10_000)

			expect(refreshes).toBe(2)
			cancel()
		} finally {
			jest.useRealTimers()
		}
	})
})

// Three genuinely different live failures used to render identically here (backlog 72). The console
// tells them apart by the CLASS control recorded, not by matching the provider's prose.
describe('namespaceFailure', () => {
	const failed = (lastError: string, lastErrorCode: string | null): DeploymentNamespaceDto => namespace({ state: 'failed', lastError, lastErrorCode })

	test('renders an authorization, a validation, and a routing failure distinguishably', () => {
		const views = [
			namespaceFailure(failed('zerops: project import failed (403) — client may not create projects', 'insufficientPermissions')),
			namespaceFailure(failed('zerops: update service env failed (400) — content is not a valid value', 'invalidUserInput')),
			namespaceFailure(failed('proxy proxy-1 exposes no deployed HTTP port', 'serviceStackIsNotHttp')),
		]

		expect(views.map((view) => view?.code)).toEqual(['insufficientPermissions', 'invalidUserInput', 'serviceStackIsNotHttp'])
		expect(new Set(views.map((view) => JSON.stringify(view))).size).toBe(3)
		expect(views[0]?.hint).toContain('token')
		expect(views[2]?.hint).toContain('deploy')
	})

	test('offers no hint for a class it has nothing to add to', () => {
		expect(namespaceFailure(failed('zerops: update service env failed (400)', 'invalidUserInput'))?.hint).toBeNull()
	})

	test('reads a row written before the codes existed, and a healthy placement', () => {
		expect(namespaceFailure(failed('namespace provision failed', null))).toEqual({
			code: null,
			message: 'namespace provision failed',
			hint: null,
		})
		expect(namespaceFailure(namespace())).toBeNull()
	})
})

// Removal deletes nothing at the provider, so it has to name what stays. Only the provider knows which
// of its facts is a live resource rather than a policy choice.
describe('retainedNamespaceResources', () => {
	const detail = (facts: DeploymentNamespaceDetailDto['presentation']): DeploymentNamespaceDetailDto => ({
		...namespace(),
		presentation: facts,
	})

	test("keeps only the facts the provider marked, in the provider's order", () => {
		const view = detail({
			preset: 'cheap',
			title: 'Cheap namespace',
			facts: [
				{ label: 'Project', value: 'apps-prod (project-1)', resource: true },
				{ label: 'Environment', value: 'prod' },
				{ label: 'Core package', value: 'LIGHT' },
			],
			instructions: [],
		})

		expect(retainedNamespaceResources(view)).toEqual([{ label: 'Project', value: 'apps-prod (project-1)', resource: true }])
	})

	test('says nothing when the provider marked nothing, and when there is no presentation at all', () => {
		const unmarked = detail({ preset: 'mid', title: 'Mid namespace', facts: [{ label: 'Project', value: 'apps-prod' }], instructions: [] })

		expect(retainedNamespaceResources(unmarked)).toEqual([])
		expect(retainedNamespaceResources(detail(null))).toEqual([])
	})
})
