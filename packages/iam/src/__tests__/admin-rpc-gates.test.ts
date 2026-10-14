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
 *
 * The one exception is named here: `appPeople.*`, which an application's own administrator calls, authorizes the
 * application's `members.manage` held globally there in its use case, and answers a stranger nothing.
 */

import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { adminRpcRouter } from '../admin/rpc'
import { createIamApp } from '../app'
import type { Env } from '../env'
import { prop } from '../json'
import { routerLeaves } from './helpers/admin-router'
import { createHarness, type Harness, seedGrant, seedUser, TEST_SIGNING_KEYS } from './helpers/harness'

const ORIGIN = 'https://iam.example.com'
const exec = { waitUntil() {} }
function env(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		ISSUER: ORIGIN,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
}

const ROUTER_METHODS = routerLeaves(adminRpcRouter)

/** The procedures an application's administrator calls without `iam.admin` (`admin/app-people.ts`). */
const DELEGATED = ['appPeople.apps', 'appPeople.grant', 'appPeople.list', 'appPeople.revoke']

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
	'principals.get': { principalId: 'nobody' },
	'principals.invite': { email: 'nobody@example.com' },
	'principals.update': { principalId: 'nobody', disabled: true },
	'principals.promote': { principalId: 'nobody' },
	'sessions.list': { principalId: 'nobody' },
	'sessions.revoke': { id: 'nobody' },
	'sessions.revokeAll': { principalId: 'nobody' },
	'passwords.issueEnrollment': { principalId: 'nobody' },
	'passwords.issueReset': { principalId: 'nobody' },
	'passwords.disable': { principalId: 'nobody' },
	'grants.create': { principalId: 'nobody', roleKey: 'admin' },
	'grants.delete': { id: 'nobody' },
	'apps.getSchema': { app: 'nowhere' },
	'apps.setReturnOrigins': { app: 'nowhere', origins: ['https://nowhere.example.com'] },
	'roles.list': { app: null },
	'policies.list': { app: 'nowhere' },
	'policies.create': { app: 'nowhere', policy: { key: 'k', name: 'n', permissions: ['*'] } },
	'policies.update': { app: 'nowhere', key: 'k', policy: { name: 'n', permissions: ['*'] } },
	'policies.delete': { app: 'nowhere', key: 'k' },
	'apiKeys.provision': { label: 'l', type: 'service', permissions: ['*'] },
	'apiKeys.rotate': { principalId: 'nobody' },
	'apiKeys.revoke': { principalId: 'nobody' },
	'workloads.issueKey': { app: 'nowhere@prod', kind: 'job', name: 'nightly', expiresAt: 4_102_444_800, keep: null },
	'workloads.revokeKeys': { app: 'nowhere@prod', kind: 'app', name: 'shop' },
	'membershipKeys.issue': { app: 'nowhere@prod', expiresAt: 4_102_444_800, keep: null },
	'shareLinks.issue': { app: 'nowhere', grants: [{ action: 'a' }], expiresAt: 1 },
	'shareLinks.revoke': { id: 'nobody' },
	'appPeople.apps': null,
	'appPeople.list': { app: 'nowhere@prod' },
	'appPeople.grant': { app: 'nowhere@prod', role: 'staff', email: 'nobody@example.com' },
	'appPeople.revoke': { app: 'nowhere@prod', role: 'staff', principalId: 'nobody' },
}

describe('every admin RPC procedure is gated', () => {
	test('the shipped router declares at least one authz requirement on every leaf', () => {
		expect(ROUTER_METHODS.length).toBeGreaterThan(20)
		expect(ROUTER_METHODS.filter((leaf) => leaf.requirements === 0).map((leaf) => leaf.method).sort()).toEqual(DELEGATED)
	})

	test('an authenticated NON-admin is refused by every method the contract declares', async () => {
		const h = createHarness()
		// A real console bearer for a real principal with a real grant — just not an admin one. This is the
		// caller a gate has to stop, and the one a missing gate would let through.
		const viewer = seedUser(h.sqlite, { sub: 'sub-viewer', email: 'viewer@example.com' })
		seedGrant(h.sqlite, viewer, 'viewer', null, 'opice')
		const bearer = await h.adminToken(viewer, { issuer: ORIGIN })
		const app = createIamApp()

		const call = (method: string) =>
			app.fetch(
				new Request(`${ORIGIN}/admin/rpc`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
					body: JSON.stringify({ method, input: Object.hasOwn(INPUTS, method) ? INPUTS[method] : {} }),
				}),
				env(h),
				exec,
			)
		const admitted: string[] = []
		for (const { method } of ROUTER_METHODS) {
			if (DELEGATED.includes(method)) continue
			const response = await call(method)
			const type = prop(prop(await response.json(), 'error'), 'type')
			if (response.status !== 403 || type !== 'forbidden') {
				admitted.push(`${method} → ${response.status} ${String(type)}`)
			}
		}
		expect(admitted).toEqual([])

		// A stranger to every application administers none: no application listed, and each other call is the 404 of an
		// application whose people it does not administer, the same as for one that does not exist.
		expect(await (await call('appPeople.apps')).json()).toEqual({ result: { items: [] } })
		for (const method of DELEGATED.filter((name) => name !== 'appPeople.apps')) {
			const response = await call(method)
			expect([method, response.status, prop(prop(await response.json(), 'error'), 'type')]).toEqual([method, 404, 'not_found'])
		}
	})
})
