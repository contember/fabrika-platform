// Every mutation of IAM's `/admin/rpc` is judged by an approval category, or is exempt with its reason (ADR-0083 §9).
// `grants` gates a person's console grant (ADR-0083 §4), `credentials` IAM's own key issuance for a machine caller and a
// machine caller's widening of what a key holds (ADR-0083 §8). A mutation added fails here until its author decides which,
// and a `credentials` one until it refuses a machine caller under `person`.

import type { PolicyCategory } from '@fabrika/control-contract'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { grantIdOf } from '../admin/grant-support'
import { adminRpcRouter } from '../admin/rpc'
import { createIamApp } from '../app'
import type { Env } from '../env'
import { routerLeaves } from './helpers/admin-router'
import { createHarness, TEST_SIGNING_KEYS } from './helpers/harness'
import { APP, membershipFixture, NOTES_SCHEMA, ORIGIN } from './helpers/membership'

/** `also` is a second category the same mutation meets: a grant to a key is a console grant and widens a credential. */
type Judged = { readonly category: PolicyCategory; readonly also?: PolicyCategory } | { readonly exempt: string }

const meets = (judged: Judged | undefined, category: PolicyCategory): boolean =>
	judged !== undefined && 'category' in judged && (judged.category === category || judged.also === category)

const ALWAYS_A_PERSON = 'always a person, whatever the mode (ADR-0083 §9)'
const NARROWS = 'takes access away; nothing to approve'
const INSTALLATION = 'installation administration keeps its rule (ADR-0083 §9)'

const IAM: Readonly<Record<string, Judged>> = {
	'principals.invite': { exempt: INSTALLATION },
	// Re-enabling a disabled principal gives back what its keys hold (a workload's at its own environment) and what the keys
	// it issued for others hold, so a machine caller meets the mode of where they act; disabling narrows.
	'principals.update': { category: 'credentials' },
	'principals.promote': { exempt: INSTALLATION },
	'sessions.revoke': { exempt: NARROWS },
	'sessions.revokeAll': { exempt: NARROWS },
	'passwords.issueEnrollment': { exempt: INSTALLATION },
	'passwords.issueReset': { exempt: INSTALLATION },
	'passwords.disable': { exempt: NARROWS },
	// A machine caller's grant to a key, or to a key's issuer, meets `credentials` before it applies or waits.
	'grants.create': { category: 'grants', also: 'credentials' },
	'grants.update': { category: 'grants', also: 'credentials' },
	'grants.delete': { category: 'grants' },
	'grantRequests.decide': { exempt: `deciding a pending item: ${ALWAYS_A_PERSON}` },
	'grantApproval.set': { exempt: "Control's mirror of the approval configuration, the provisioning key only" },
	'scopeValues.list': { exempt: 'a read served as a mutation; writes nothing' },
	'apps.setReturnOrigins': { exempt: `where IAM returns an application's sign-in: ${INSTALLATION}` },
	'connections.revoke': { exempt: NARROWS },
	// A named policy keeps the installation's rule for a person; its holders gain what it gains, keys among them, so a
	// machine caller meets the application's `credentials` (ADR-0083 §8). A grant names a role by key alone, so a policy
	// created under a deleted role's key reaches every key still naming it.
	'policies.create': { category: 'credentials' },
	'policies.update': { category: 'credentials' },
	'policies.delete': { exempt: `a named policy under \`iam.admin\`: ${INSTALLATION}` },
	'apiKeys.provision': { category: 'credentials' },
	// The execution of a `credentials` request a person approved in Control, by that person in a session (ADR-0083 §8).
	'apiKeys.provisionRequested': { category: 'credentials' },
	// A new secret for the principal's grants.
	'apiKeys.rotate': { category: 'credentials' },
	'apiKeys.revoke': { exempt: NARROWS },
	// Also the connector key (kind `app`). The provisioning key's issuance keeps its rule: `EXCEPTIONS` below.
	'workloads.issueKey': { category: 'credentials' },
	'workloads.revokeKeys': { exempt: NARROWS },
	'membershipKeys.issue': { category: 'credentials' },
	'shareLinks.issue': { category: 'credentials' },
	'shareLinks.revoke': { exempt: NARROWS },
	'terminals.setProfile': { exempt: INSTALLATION },
	'terminals.revoke': { exempt: NARROWS },
	'appPeople.grant': { category: 'grants' },
	'appPeople.revoke': { category: 'grants' },
	'brand.set': { exempt: INSTALLATION },
	'brand.clear': { exempt: INSTALLATION },
	'passwordPolicy.set': { exempt: INSTALLATION },
	'secondFactor.reset': { exempt: INSTALLATION },
	'externalApps.put': { exempt: `where IAM sends people's identity: ${INSTALLATION}` },
	'externalApps.delete': { exempt: NARROWS },
	'oauthClients.put': { exempt: "the operator's MCP authoring client, the provisioning key only" },
	'oauthClients.delete': { exempt: NARROWS },
	// A person's own passkeys, in a signed-in session only: a key never reaches them, so nothing is left to wait.
	'passkeys.registrationOptions': { exempt: `the caller's own passkey: ${ALWAYS_A_PERSON}` },
	'passkeys.register': { exempt: `the caller's own passkey, after a step-up once one exists: ${ALWAYS_A_PERSON}` },
	'passkeys.remove': { exempt: `the caller's own passkey, after a step-up: ${ALWAYS_A_PERSON}` },
	'passkeys.challenge': { exempt: `a step-up challenge; grants nothing: ${ALWAYS_A_PERSON}` },
	'passkeys.verify': { exempt: `verifies a step-up; grants nothing: ${ALWAYS_A_PERSON}` },
	'passkeys.reset': { exempt: `removes a person's passkeys under \`iam.admin\`: ${ALWAYS_A_PERSON}` },
}

/**
 * The two issuances that keep their rule under every `credentials` mode, with why (ADR-0083 §8). Both are the
 * provisioning key's, the operator's own credential, which Control holds; any other caller meets the mode on them.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {
	'workloads.issueKey': "Control's own workload and connector keys, which every deploy issues with the provisioning key",
	'membershipKeys.issue': "Control's own membership transport key, which every deploy issues with the provisioning key",
	'POST /admin/api-keys': 'the bootstrap of the first machine caller, before any console or key exists, with the provisioning key',
}

/** The REST mutations that meet `credentials` for a machine caller: the bootstrap's issuance and the vocabulary a role widens through. */
const REST_CREDENTIALS = ['POST /admin/api-keys', 'PUT /admin/apps/:app/schema'] as const

/** The mutations neither judged nor exempt, and the entries that name no mutation: both empty, or the table is stale. */
function tableProblems(mutations: readonly string[], table: Readonly<Record<string, Judged>>): { unlisted: string[]; unknown: string[] } {
	return {
		unlisted: mutations.filter((method) => table[method] === undefined).sort(),
		unknown: Object.keys(table).filter((method) => !mutations.includes(method)).sort(),
	}
}

const MUTATIONS = routerLeaves(adminRpcRouter).filter((leaf) => leaf.kind === 'mutation').map((leaf) => leaf.method)

describe('every IAM administration mutation is judged by an approval category or exempt with its reason', () => {
	test('the shipped router', () => {
		expect(tableProblems(MUTATIONS, IAM)).toEqual({ unlisted: [], unknown: [] })
	})

	test('a mutation added without an entry fails the table, and so does an entry left behind', () => {
		expect(tableProblems([...MUTATIONS, 'apiKeys.mint'], IAM)).toEqual({ unlisted: ['apiKeys.mint'], unknown: [] })
		expect(tableProblems(MUTATIONS.filter((method) => method !== 'brand.set'), IAM)).toEqual({ unlisted: [], unknown: ['brand.set'] })
	})

	test('every `credentials` mutation refuses a px_ key holding `iam.admin` under `person`; the exceptions admit the provisioning key', async () => {
		const provisioningKey = 'px_provisioning-key-of-the-categories-suite'
		const h = createHarness()
		const f = await membershipFixture(h.repositories)
		const env: Env = {
			DB: unusedDatabase,
			REPOSITORIES: h.repositories,
			HUMAN_EMAIL_DOMAINS: '[]',
			HUMAN_EMAILS: '[]',
			IAM_BOOTSTRAP_ADMINS: '[]',
			ENVIRONMENT: 'stage',
			ISSUER: ORIGIN,
			FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
			FABRIKA_IAM_PROVISIONING_KEY: provisioningKey,
			OIDC_ISSUER: 'https://idp.test',
			OIDC_CLIENT_ID: 'client',
			OIDC_CLIENT_SECRET: 'secret',
			OIDC_SCOPES: '',
			OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
		}
		const send = async (bearer: string, path: string, body: unknown): Promise<{ status: number; message: string }> => {
			const response = await createIamApp().fetch(
				new Request(`${ORIGIN}${path}`, {
					method: 'POST',
					headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				}),
				env,
				f.ctx,
			)
			const text = await response.text()
			return { status: response.status, message: text }
		}
		const rpc = (bearer: string, method: string, input: unknown) => send(bearer, '/admin/rpc', { method, input })
		const restCall = (bearer: string, method: string, path: string, body: unknown) =>
			createIamApp().fetch(
				new Request(`${ORIGIN}${path}`, {
					method,
					headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				}),
				env,
				f.ctx,
			)
		const expiresAt = Math.floor(Date.now() / 1000) + 24 * 3600
		const bootstrapped = await send(provisioningKey, '/admin/api-keys', { label: 'ci administrator', type: 'service', roleKey: 'admin' })
		const machine = String(JSON.parse(bootstrapped.message).apiKey)
		const existing = String(
			JSON.parse((await send(provisioningKey, '/admin/api-keys', { label: 'export', type: 'service', app: APP, roleKey: 'support' })).message)
				.principalId,
		)
		const dormant = String(
			JSON.parse((await send(provisioningKey, '/admin/api-keys', { label: 'dormant', type: 'service', app: APP, roleKey: 'support' })).message)
				.principalId,
		)
		expect((await rpc(provisioningKey, 'principals.update', { principalId: dormant, disabled: true })).status).toBe(200)
		const [existingGrant] = await h.repositories.grants.listGrants(existing)
		if (existingGrant === undefined) throw new Error('the key holds no grant')
		const policy = { key: 'reviewer', name: 'Reviewer', permissions: ['notes.read'] }
		expect((await rpc(provisioningKey, 'policies.create', { app: APP, policy })).status).toBe(200)
		expect((await rpc(provisioningKey, 'grantApproval.set', { app: APP, required: false, revision: 1, credentials: 'person' })).status).toBe(200)

		// One input per `credentials` mutation, at the environment under `person`; a new one fails here until it has one.
		const inputs: Readonly<Record<string, unknown>> = {
			'apiKeys.provision': { label: 'k', type: 'service', app: APP, roleKey: 'support', expiresAt },
			'apiKeys.provisionRequested': {
				label: 'k',
				app: APP,
				permissions: ['notes.read'],
				scopeType: null,
				scopeValue: null,
				expiresAt,
				recipient: { kty: 'OKP', crv: 'X25519', x: 'hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo' },
				approvalRequest: { id: 'request-1', requester: { id: 'agent', label: 'agent' } },
			},
			'apiKeys.rotate': { principalId: existing },
			'workloads.issueKey': { app: APP, kind: 'job', name: 'nightly', expiresAt, keep: null },
			'membershipKeys.issue': { app: APP, expiresAt, keep: null },
			'shareLinks.issue': { app: APP, grants: [{ action: 'notes.read', scope: { type: 'note', value: 'n-1' } }], expiresAt },
			'grants.create': { principalId: existing, app: APP, roleKey: 'staff' },
			'grants.update': { id: grantIdOf(existingGrant), roleKey: 'staff' },
			'policies.update': { app: APP, key: policy.key, policy: { name: policy.name, permissions: ['notes.read', 'notes.admin'] } },
			'policies.create': { app: APP, policy: { key: 'auditor', name: 'Auditor', permissions: ['notes.read'] } },
			'principals.update': { principalId: dormant, disabled: false },
		}
		const credentials = MUTATIONS.filter((method) => meets(IAM[method], 'credentials'))
		const admitted: string[] = []
		for (const method of credentials) {
			const answer = await rpc(machine, method, inputs[method] ?? null)
			if (answer.status !== 403) admitted.push(`${method} → ${answer.status} ${answer.message}`)
		}
		expect(admitted).toEqual([])

		const rest: Readonly<Record<(typeof REST_CREDENTIALS)[number], () => Promise<Response>>> = {
			'POST /admin/api-keys': () =>
				restCall(machine, 'POST', '/admin/api-keys', { label: 'k', type: 'service', app: APP, roleKey: 'support', expiresAt }),
			'PUT /admin/apps/:app/schema': () => restCall(machine, 'PUT', `/admin/apps/${encodeURIComponent(APP)}/schema`, NOTES_SCHEMA),
		}
		const restAdmitted: string[] = []
		for (const route of REST_CREDENTIALS) {
			const answer = await rest[route]()
			if (answer.status !== 403) restAdmitted.push(`${route} → ${answer.status} ${await answer.text()}`)
		}
		expect(restAdmitted).toEqual([])

		expect(Object.keys(EXCEPTIONS).filter((exception) => exception.includes(' ') || IAM[exception] !== undefined)).toEqual(Object.keys(EXCEPTIONS))
		for (const exception of Object.keys(EXCEPTIONS)) {
			const answer = exception === 'POST /admin/api-keys'
				? await send(provisioningKey, '/admin/api-keys', { label: 'first machine', type: 'service', app: APP, roleKey: 'support' })
				: await rpc(provisioningKey, exception, inputs[exception])
			expect([exception, answer.status < 300]).toEqual([exception, true])
		}
	})
})
