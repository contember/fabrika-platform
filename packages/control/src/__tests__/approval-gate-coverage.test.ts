// Every mutation of Control's router is judged by an approval category, or is exempt with its reason (ADR-0083 §9);
// IAM's `/admin/rpc` has its table in IAM. A mutation added fails here until its author decides which: a category list
// misses writes, and each miss is a way around the gate.

import { dispatchRpcRequest } from '@fabrika/app/service'
import { ACTION_CATEGORIES, type PolicyCategory, STRICT_POLICY, STRICT_SETTINGS } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { type ControlRpcContext, controlRpcRouter } from '../control-rpc'
import { createHarness } from './helpers/harness'
import { authWithActions } from './helpers/iam'
import { fakeControlProvider } from './helpers/provider'
import { unusedSourceConnection } from './helpers/source-connection'

type Judged = { readonly category: PolicyCategory } | { readonly exempt: string }

const ALWAYS_A_PERSON = 'always a person, whatever the mode (ADR-0083 §9)'
const NARROWS = 'takes access away; nothing to approve'
const NAMESPACE = 'an installation resource under the global `namespace.manage`, which no command-line preset carries (ADR-0083 §9)'
const MAIL = "the installation's mail gate under the global `mail.manage`, which no command-line preset carries (ADR-0083 §9)"

/** Control's mutations. A non-person's action of a category waits or is refused by its mode, from the step that adds its requests. */
const CONTROL: Readonly<Record<string, Judged>> = {
	'builderPairing.approve': { exempt: `builder pairing: ${ALWAYS_A_PERSON}` },
	'builderPairing.deny': { exempt: `builder pairing: ${ALWAYS_A_PERSON}` },
	'builderPairing.revoke': { exempt: NARROWS },
	'builderConnections.createReceipt': { exempt: 'records the non-secret receipt of a pairing a person approved' },
	'sourceConnection.start': { exempt: `source connections: ${ALWAYS_A_PERSON}` },
	'sourceConnection.handoff': { exempt: `source connections: ${ALWAYS_A_PERSON}` },
	'sourceConnection.cancel': { exempt: `source connections: ${ALWAYS_A_PERSON}` },
	'sourceConnection.verifyInstallation': { exempt: `source connections: ${ALWAYS_A_PERSON}` },
	'sourceConnection.repair': { exempt: `source connections: ${ALWAYS_A_PERSON}` },
	'sourceConnection.reconcile': { exempt: `source connections: ${ALWAYS_A_PERSON}` },
	'apps.create': { exempt: 'creates an application, none of whose environments exists yet' },
	'apps.update': { category: 'registry' },
	'apps.delete': { exempt: `deleting an application with a protected environment: ${ALWAYS_A_PERSON}` },
	'apps.environments.put': { category: 'registry' },
	'apps.environments.delete': { exempt: `deleting a protected environment: ${ALWAYS_A_PERSON}` },
	'apps.environments.protect': { exempt: `the approval configuration: ${ALWAYS_A_PERSON}` },
	'apps.environments.protectChallenge': {
		exempt: `a passkey challenge for a change of the approval configuration, which IAM issues and nothing else changes: ${ALWAYS_A_PERSON}`,
	},
	'apps.environments.rotateTokenKey': { category: 'secrets' },
	'apps.environments.suspend': { category: 'data' },
	'apps.environments.resume': { category: 'data' },
	'apps.secrets.put': { category: 'secrets' },
	'apps.secrets.delete': { category: 'secrets' },
	'apps.variables.put': { category: 'variables' },
	'apps.variables.delete': { category: 'variables' },
	'vault.set': { category: 'secrets' },
	'vault.rotate': { category: 'secrets' },
	'vault.delete': { category: 'secrets' },
	'namespaces.create': { exempt: NAMESPACE },
	'namespaces.adopt': { exempt: NAMESPACE },
	'namespaces.reconcile': { exempt: 'converges a namespace on its stored state; changes no choice' },
	'namespaces.update': { exempt: NAMESPACE },
	'namespaces.remove': { exempt: 'never requested (ADR-0034 frees resources); keeps its rule' },
	'namespaces.republishAll': { exempt: 'republishes stored state; changes no choice' },
	'namespaces.releaseClaims': { exempt: 'never requested (ADR-0034 frees resources); keeps its rule' },
	'runs.cancel': { exempt: 'stops a run; deploys nothing' },
	'approvals.complete': { exempt: `deciding a pending item: ${ALWAYS_A_PERSON}` },
	'approvals.challenge': { exempt: `a passkey challenge for deciding a pending item, which IAM issues and nothing else changes: ${ALWAYS_A_PERSON}` },
	'approvals.requests.create': {
		exempt: "request plumbing: stores an inert request; its change runs only on a person's approval, judged by its kind's category",
	},
	'approvals.requests.decide': { exempt: `deciding a pending item: ${ALWAYS_A_PERSON}` },
	'approvals.requests.challenge': {
		exempt: `a passkey challenge for deciding a pending item, which IAM issues and nothing else changes: ${ALWAYS_A_PERSON}`,
	},
	'deploy': { category: 'deploy-request' },
	'register': { category: 'registry' },
	'mail.messages.release': { exempt: MAIL },
	'mail.messages.drop': { exempt: NARROWS },
	'mail.messages.requeue': { exempt: MAIL },
	'mail.rules.set': { exempt: MAIL },
	'mail.rules.remove': { exempt: MAIL },
	'data.start': { category: 'data' },
	'data.recover': { category: 'data' },
	'data.backups.setSchedule': { category: 'data' },
}

/** Every mutation of a shipped router, as `a.b.c`. */
function mutations(node: unknown, path: readonly string[] = []): string[] {
	if (node === null || typeof node !== 'object') return []
	const tag = Reflect.get(node, '_tag')
	if (tag === 'procedure') return Reflect.get(node, 'kind') === 'mutation' ? [path.join('.')] : []
	if (tag !== 'router') return []
	const def: unknown = Reflect.get(node, '_def')
	if (def === null || typeof def !== 'object') return []
	return Object.entries(def).flatMap(([key, child]) => mutations(child, [...path, key]))
}

describe('every Control mutation is judged by an approval category or exempt with its reason', () => {
	test("Control's router", () => {
		expect(mutations(controlRpcRouter).sort()).toEqual(Object.keys(CONTROL).sort())
	})

	test("every action category but IAM's judges a Control mutation", () => {
		const judged = new Set(Object.values(CONTROL).flatMap((entry) => 'category' in entry ? [entry.category] : []))
		// `grants` and `credentials` judge IAM's mutations; `agent-grants` judges a request, which no router mutation is yet.
		expect(ACTION_CATEGORIES.filter((category) => !judged.has(category))).toEqual(['agent-grants', 'credentials'])
	})
})

describe('the mode matrix at the protection API', () => {
	const ctx = (request: Request): ControlRpcContext => {
		const harness = createHarness()
		return {
			auth: authWithActions([]),
			env: {
				DB: harness.d1,
				REPOSITORIES: harness.repositories,
				ASSETS: { fetch: () => Promise.resolve(new Response('')) },
				RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
				DEPLOY_QUEUE: { send: () => Promise.resolve() },
				WAIT_UNTIL: () => {},
				ENVIRONMENT: 'local',
				FABRIKA_CONTROL_DOMAIN: 'https://control.test',
			},
			provider: fakeControlProvider,
			sourceConnection: unusedSourceConnection('harbor'),
			request,
		}
	}
	const protect = async (policy: unknown, settings?: unknown) => {
		const input = { appId: 'notes', env: 'prod', protected: true, policy, ...(settings === undefined ? {} : { settings }) }
		const request = new Request('https://control.test/api/rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ method: 'apps.environments.protect', input }),
		})
		return (await dispatchRpcRequest({ router: controlRpcRouter, ctx: ctx(request), request })).status
	}

	test('a mode a category does not take is refused with a 400 before anything runs', async () => {
		expect(await protect({ ...STRICT_POLICY, secrets: 'plan' })).toBe(400)
		expect(await protect({ ...STRICT_POLICY, grants: 'plan' })).toBe(400)
		expect(await protect({ ...STRICT_POLICY, 'off-road': 'refuse' })).toBe(400)
		expect(await protect({ ...STRICT_POLICY, credentials: 'sometimes' })).toBe(400)
		const { secrets: _, ...missing } = STRICT_POLICY
		expect(await protect(missing)).toBe(400)
	})

	test('settings out of their range are refused with a 400 before anything runs', async () => {
		const approvers = { ...STRICT_SETTINGS.approvers }
		// A valid input passes validation and stops past it: the environment does not exist.
		expect(await protect(STRICT_POLICY, STRICT_SETTINGS)).toBe(404)
		expect(await protect(STRICT_POLICY, { ...STRICT_SETTINGS, deployRequestCommits: 'unmerged' })).toBe(400)
		for (const requestTtlHours of [0, 169, 1.5]) expect(await protect(STRICT_POLICY, { ...STRICT_SETTINGS, requestTtlHours })).toBe(400)
		expect(await protect(STRICT_POLICY, { ...STRICT_SETTINGS, approvers: { ...approvers, secrets: 3 } })).toBe(400)
		expect(await protect(STRICT_POLICY, { ...STRICT_SETTINGS, approvers: { ...approvers, grants: 2 } })).toBe(400)
		const { secrets: _, ...missing } = approvers
		expect(await protect(STRICT_POLICY, { ...STRICT_SETTINGS, approvers: missing })).toBe(400)
		expect(await protect(STRICT_POLICY, { ...STRICT_SETTINGS, stepUp: true })).toBe(400)
		expect(await protect(STRICT_POLICY, { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, secrets: 'totp' } })).toBe(400)
		expect(await protect(STRICT_POLICY, { ...STRICT_SETTINGS, stepUp: { ...STRICT_SETTINGS.stepUp, grants: 'webauthn' } })).toBe(400)
		const { stepUp: _stepUp, ...withoutStepUp } = STRICT_SETTINGS
		expect(await protect(STRICT_POLICY, withoutStepUp)).toBe(400)
	})
})
