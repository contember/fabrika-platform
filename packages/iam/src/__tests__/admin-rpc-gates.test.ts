/**
 * EVERY admin RPC procedure requires `iam.admin`, and no future one can lose that quietly.
 *
 * The gate is per-procedure (`t.procedure.…require(ADMIN_ACTION)`) and the builder RESETS recorded
 * requirements when `.input()` is called, so a procedure written as `.require(X).input(Y)` silently
 * ships with no gate at all. Nothing structural prevented that; the whole defense was that every
 * author remembered. Two checks replace the remembering (SEC-11):
 *
 *   1. Walk the shipped router and assert every leaf carries at least one requirement. This catches an
 *      omission — including the `.require()` before `.input()` ordering trap — without a live request.
 *   2. Enumerate every method the CONTRACT declares and call it with an authenticated NON-ADMIN, then
 *      assert 403. This catches a procedure that is gated on the wrong action, and it fails when a
 *      method is added to the contract and forgotten here, which is the point: the list of methods is
 *      derived from the contract's own shape, not typed out.
 */

import type { SqlDatabase } from '@fabrika/platform'
import { describe, expect, test } from 'bun:test'
import { adminRpcRouter } from '../admin/rpc'
import { createIamApp } from '../app'
import type { Env } from '../env'
import { prop } from '../json'
import { createHarness, type Harness, seedGrant, seedUser } from './helpers/harness'

const ORIGIN = 'https://iam.example.com'
const exec = { waitUntil() {} }
const unusedDatabase: SqlDatabase = {
	prepare() {
		throw new Error('database access was not expected')
	},
	batch() {
		return Promise.reject(new Error('database access was not expected'))
	},
}

function env(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ADMIN_ORIGINS: JSON.stringify([ORIGIN]),
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

interface Leaf {
	method: string
	requirements: number
}

/** Every procedure in the shipped router, as `a.b.c` with the number of authz requirements on it. */
function leaves(node: unknown, path: string[] = []): Leaf[] {
	if (node === null || typeof node !== 'object') {
		return []
	}
	const tag = Reflect.get(node, '_tag')
	if (tag === 'procedure') {
		const requirements = Reflect.get(node, 'requirements')
		return [{ method: path.join('.'), requirements: Array.isArray(requirements) ? requirements.length : 0 }]
	}
	if (tag === 'router') {
		const def = Reflect.get(node, '_def')
		if (def === null || typeof def !== 'object') {
			return []
		}
		return Object.entries(def).flatMap(([key, child]) => leaves(child, [...path, key]))
	}
	return []
}

const ROUTER_METHODS = leaves(adminRpcRouter)

/**
 * A minimally-shaped input for each method — enough to pass validation IF the gate were missing, so a
 * 400 can never be mistaken for a refusal. Anything absent here gets `{}`, which is correct for every
 * procedure whose input is fully optional.
 */
const INPUTS: Record<string, unknown> = {
	// `null` = "no input", which is what a procedure with no `.input()` schema accepts.
	me: null,
	'apps.list': null,
	'apiKeys.list': null,
	'shareLinks.list': null,
	'principals.get': { id: 'nobody' },
	'principals.invite': { email: 'nobody@example.com' },
	'principals.update': { id: 'nobody', disabled: true },
	'principals.delete': { id: 'nobody' },
	'sessions.list': { principalId: 'nobody' },
	'sessions.revoke': { id: 'nobody' },
	'sessions.revokeAll': { id: 'nobody' },
	'passwords.issueEnrollment': { id: 'nobody' },
	'passwords.issueReset': { id: 'nobody' },
	'passwords.disable': { id: 'nobody' },
	'grants.create': { principalId: 'nobody', roleKey: 'admin' },
	'grants.delete': { id: 'nobody' },
	'apps.getSchema': { app: 'nowhere' },
	'apps.getReturnOrigins': { app: 'nowhere' },
	'apps.setReturnOrigins': { app: 'nowhere', origins: ['https://nowhere.example.com'] },
	'apps.clearReturnOrigins': { app: 'nowhere' },
	'roles.list': { app: null },
	'policies.list': { app: 'nowhere' },
	'policies.create': { app: 'nowhere', policy: { key: 'k', name: 'n', permissions: ['*'] } },
	'policies.update': { app: 'nowhere', key: 'k', policy: { name: 'n', permissions: ['*'] } },
	'policies.delete': { app: 'nowhere', key: 'k' },
	'apiKeys.provision': { label: 'l', type: 'service', permissions: ['*'] },
	'apiKeys.rotate': { principalId: 'nobody' },
	'apiKeys.revoke': { principalId: 'nobody' },
	'shareLinks.issue': { app: 'nowhere', grants: [{ action: 'a' }] },
	'shareLinks.revoke': { id: 'nobody' },
}

describe('every admin RPC procedure is gated', () => {
	test('the shipped router declares at least one authz requirement on every leaf', () => {
		expect(ROUTER_METHODS.length).toBeGreaterThan(20)
		expect(ROUTER_METHODS.filter((leaf) => leaf.requirements === 0)).toEqual([])
	})

	test('an authenticated NON-admin is refused by every method the contract declares', async () => {
		const h = createHarness()
		// A real, live session for a real principal with a real grant — just not an admin one. This is the
		// caller a gate has to stop, and the one a missing gate would let through.
		const viewer = seedUser(h.sqlite, { sub: 'sub-viewer', email: 'viewer@example.com' })
		seedGrant(h.sqlite, viewer, 'viewer', null, 'opice')
		const session = await h.signSession(viewer)
		const app = createIamApp()

		const admitted: string[] = []
		for (const { method } of ROUTER_METHODS) {
			const response = await app.fetch(
				new Request(`${ORIGIN}/admin/rpc`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: `__Host-px_session=${session}` },
					body: JSON.stringify({ method, input: Object.hasOwn(INPUTS, method) ? INPUTS[method] : {} }),
				}),
				env(h),
				exec,
			)
			const type = prop(prop(await response.json(), 'error'), 'type')
			if (response.status !== 403 || type !== 'forbidden') {
				admitted.push(`${method} → ${response.status} ${String(type)}`)
			}
		}

		expect(admitted).toEqual([])
	})
})
