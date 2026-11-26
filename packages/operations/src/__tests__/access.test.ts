import type { AuthContext } from '@fabrika/auth'
import type { PermissionEntry, PrincipalListItem, Scope } from '@fabrika/auth-core'
import { permits, scopedValues } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { canAccessOperationsSource, filterOperationsSources, normalizeIssueAssignment, OPERATIONS_ACTIONS } from '../access.js'
import { INSTALLATION_SOURCE } from '../installation-source.js'

function auth(entries: PermissionEntry[]): Pick<AuthContext, 'can' | 'scopedTo'> {
	return {
		can: (action: string, scope?: Scope) => permits(entries, action, scope),
		scopedTo: (action: string, dimension: string) => scopedValues(entries, action, dimension),
	}
}

const sources: [
	{ id: string; appId: string; environment: string; serviceKey: string },
	{ id: string; appId: string; environment: string; serviceKey: string },
	{ id: string; appId: string; environment: string; serviceKey: string },
	{ id: string; appId: string; environment: string; serviceKey: string },
] = [
	{ id: 'a-prod', appId: 'app-a', environment: 'production', serviceKey: 'default' },
	{ id: 'a-stage', appId: 'app-a', environment: 'stage', serviceKey: 'default' },
	{ id: 'b-prod', appId: 'app-b', environment: 'production', serviceKey: 'api' },
	{ id: 'b-stage', appId: 'app-b', environment: 'stage', serviceKey: 'default' },
]

describe('Operations access helpers', () => {
	test('uses the union of independent app and environment scopes', () => {
		const context = auth([
			{ action: OPERATIONS_ACTIONS.READ, scope: { type: 'app', value: 'app-a' }, source: 'grant' },
			{ action: OPERATIONS_ACTIONS.READ, scope: { type: 'environment', value: 'production' }, source: 'grant' },
		])
		expect(filterOperationsSources(context, OPERATIONS_ACTIONS.READ, sources).map((source) => source.id)).toEqual([
			'a-prod',
			'a-stage',
			'b-prod',
		])
		expect(canAccessOperationsSource(context, OPERATIONS_ACTIONS.READ, sources[1])).toBe(true)
		expect(canAccessOperationsSource(context, OPERATIONS_ACTIONS.READ, sources[3])).toBe(false)
	})

	test('global permission sees all while read does not imply triage', () => {
		const context = auth([{ action: OPERATIONS_ACTIONS.READ, scope: null, source: 'grant' }])
		expect(filterOperationsSources(context, OPERATIONS_ACTIONS.READ, sources)).toEqual(sources)
		expect(canAccessOperationsSource(context, OPERATIONS_ACTIONS.TRIAGE, sources[0])).toBe(false)
	})

	test('the installation source takes an app-scoped grant at IAM or a global one, never an environment-scoped one', () => {
		const installation = { id: 'installation', appId: INSTALLATION_SOURCE.appId, environment: INSTALLATION_SOURCE.environment, serviceKey: 'default' }
		const all = [...sources, installation]
		const byEnvironment = auth([
			{ action: OPERATIONS_ACTIONS.MANAGE, scope: { type: 'environment', value: INSTALLATION_SOURCE.environment }, source: 'grant' },
			{ action: OPERATIONS_ACTIONS.MANAGE, scope: { type: 'environment', value: 'production' }, source: 'grant' },
		])
		expect(canAccessOperationsSource(byEnvironment, OPERATIONS_ACTIONS.MANAGE, installation)).toBe(false)
		expect(filterOperationsSources(byEnvironment, OPERATIONS_ACTIONS.MANAGE, all).map((source) => source.id)).toEqual(['a-prod', 'b-prod'])

		const byApp = auth([{ action: OPERATIONS_ACTIONS.READ, scope: { type: 'app', value: INSTALLATION_SOURCE.appId }, source: 'grant' }])
		expect(canAccessOperationsSource(byApp, OPERATIONS_ACTIONS.READ, installation)).toBe(true)
		expect(filterOperationsSources(byApp, OPERATIONS_ACTIONS.READ, all).map((source) => source.id)).toEqual(['installation'])

		const global = auth([{ action: OPERATIONS_ACTIONS.READ, scope: null, source: 'grant' }])
		expect(canAccessOperationsSource(global, OPERATIONS_ACTIONS.READ, installation)).toBe(true)
	})

	test('assignment snapshots only an active IAM user label', () => {
		const principals: PrincipalListItem[] = [
			{ id: 'user-a', type: 'user', label: 'a@example.test', email: 'a@example.test', disabled: false },
			{ id: 'user-b', type: 'user', label: 'b@example.test', email: 'b@example.test', disabled: true },
		]
		expect(normalizeIssueAssignment(
			{ kind: 'assign', principalId: 'user-a', principalLabel: 'forged' },
			principals,
		)).toEqual({ kind: 'assign', principalId: 'user-a', principalLabel: 'a@example.test' })
		expect(() =>
			normalizeIssueAssignment(
				{ kind: 'assign', principalId: 'user-b', principalLabel: 'b@example.test' },
				principals,
			)
		).toThrow('assignee is not an active IAM user')
	})
})
