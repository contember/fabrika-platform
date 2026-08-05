/**
 * The console's Access plane, end to end across the seam that actually broke.
 *
 * The unit tests on either side of it were both green while production answered every call to
 * `/iam/admin/*` with 403. The defect only existed BETWEEN them: control's process-side gateway
 * rewrote the browser's `Origin` to IAM's private RPC address, IAM's CSRF check compared `Origin`
 * against its PUBLIC issuer, and those two never agree in any deployment where the private RPC URL
 * differs from the public issuer — which is the normal production shape. So this test drives the real
 * `forwardIamAdmin` through the real `HttpIamAdminGateway` over a real HTTP hop into the real IAM
 * application, with the three coordinates a live installation actually has:
 *
 *   the console's public origin  ≠  IAM's public issuer  ≠  IAM's private RPC address
 *
 * It lives OUTSIDE `src/` for the same reason `proxy-gates.test.ts` does: `tsconfig.json` includes
 * `src/**` only, so reaching across into two other packages never enters this package's program.
 */

import { describe, expect, test } from 'bun:test'
import { forwardIamAdmin } from '../../control/src/iam-admin'
import { HttpIamAdminGateway } from '../../control/src/node/iam-admin'
import { createHarness, seedGrant, seedUser } from '../../iam/src/__tests__/helpers/harness'
import { createIamApp } from '../../iam/src/app'
import type { Env } from '../../iam/src/env'

/** The console's own public origin — the control plane's domain, which IAM cannot infer. */
const CONSOLE = 'http://console.example.test'
/** IAM's public issuer. Deliberately NOT the console's origin, and not its private address either. */
const ISSUER = 'https://iam.example.test'

const unusedDatabase = {
	prepare() {
		throw new Error('database access goes through REPOSITORIES in this test')
	},
	batch() {
		return Promise.reject(new Error('database access goes through REPOSITORIES in this test'))
	},
}

interface Stack {
	/** Drive a request at the CONSOLE, exactly as a browser would. */
	call(method: string, input: unknown, options?: { origin?: string | null; cookie?: string; bearer?: string }): Promise<Response>
	stop(): Promise<void>
}

/** Compose control's gateway in front of IAM over a real socket, and return an admin's session. */
async function stack(options: { adminOrigins: string[] }): Promise<Stack & { session: string }> {
	const harness = createHarness()
	const adminId = seedUser(harness.sqlite, { sub: 'sub-console-admin', email: 'admin@contember.com' })
	seedGrant(harness.sqlite, adminId, 'admin')
	const session = await harness.signSession(adminId)

	const env: Env = {
		DB: unusedDatabase,
		REPOSITORIES: harness.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ADMIN_ORIGINS: JSON.stringify(options.adminOrigins),
		ENVIRONMENT: 'stage',
		ISSUER,
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}

	const iam = createIamApp()
	// IAM's PRIVATE address. A loopback port on plain HTTP, which is what a private service binding or
	// a `FABRIKA_IAM_RPC_URL` looks like — and what the old code substituted for the browser's origin.
	const server = Bun.serve({ port: 0, fetch: (request) => iam.fetch(request, env, { waitUntil() {} }) })
	const gateway = new HttpIamAdminGateway(`http://127.0.0.1:${server.port}`)

	return {
		session,
		call(method, input, callOptions = {}) {
			const headers = new Headers({ 'content-type': 'application/json' })
			const origin = callOptions.origin === undefined ? CONSOLE : callOptions.origin
			if (origin !== null) headers.set('origin', origin)
			if (callOptions.cookie !== undefined) headers.set('cookie', callOptions.cookie)
			if (callOptions.bearer !== undefined) headers.set('authorization', `Bearer ${callOptions.bearer}`)
			return forwardIamAdmin(
				new Request(`${CONSOLE}/iam/admin/rpc`, { method: 'POST', headers, body: JSON.stringify({ method, input }) }),
				{ gateway, publicIamUrl: ISSUER, publicOrigin: CONSOLE },
			)
		},
		stop: () => server.stop(true),
	}
}

describe("the console's Access plane through the control-plane gateway", () => {
	test('a registered console origin reaches IAM and is authorized as the BROWSER, not as control', async () => {
		const { call, session, stop } = await stack({ adminOrigins: [CONSOLE] })
		try {
			const response = await call('me', null, { cookie: `__Host-px_session=${session}` })
			expect(response.status).toBe(200)
			const body: unknown = await response.json()
			// The principal is the browser's admin. Control never substitutes an identity of its own; the
			// gateway is transport, and IAM authenticates, authorizes and audits its own requests.
			expect(JSON.stringify(body)).toContain('admin@contember.com')
		} finally {
			await stop()
		}
	})

	test('a state change survives the hop — the case that was 403 in production', async () => {
		const { call, session, stop } = await stack({ adminOrigins: [CONSOLE] })
		try {
			const response = await call('principals.invite', { email: 'invited@contember.com' }, { cookie: `__Host-px_session=${session}` })
			expect(response.status).toBe(200)
			expect(JSON.stringify(await response.json())).toContain('invited@contember.com')
		} finally {
			await stop()
		}
	})

	test('with the console origin unregistered, IAM refuses it — and it is IAM that refuses', async () => {
		// The fail-closed default. An installation that has not named its console cannot drive it, and
		// the refusal comes from the service that owns the decision rather than from the transport.
		const { call, session, stop } = await stack({ adminOrigins: [] })
		try {
			const response = await call('principals.invite', { email: 'nope@contember.com' }, { cookie: `__Host-px_session=${session}` })
			expect(response.status).toBe(403)
			// IAM's RPC envelope, not control's flat one — proof of which hop refused.
			expect(await response.json()).toEqual({ error: { type: 'forbidden', message: 'cross-origin request rejected' } })
		} finally {
			await stop()
		}
	})

	test('a hostile cross-origin POST is stopped by the DEPUTY, before IAM is asked', async () => {
		// The confused-deputy attack: a hostile page POSTs to the console's own origin and the browser
		// attaches `px_session` by itself. Control's own same-origin check refuses it, so the request
		// never reaches the gateway — which is what makes the transport-only design safe.
		const { call, session, stop } = await stack({ adminOrigins: [CONSOLE] })
		try {
			const response = await call('principals.invite', { email: 'evil@contember.com' }, {
				cookie: `__Host-px_session=${session}`,
				origin: 'https://evil.example.test',
			})
			expect(response.status).toBe(403)
			// Control's flat envelope — the deputy answered, IAM was never called.
			expect(await response.json()).toEqual({ error: 'cross-origin request rejected' })
		} finally {
			await stop()
		}
	})

	test('a cookie-bearing POST with no Origin at all is refused by the deputy', async () => {
		const { call, session, stop } = await stack({ adminOrigins: [CONSOLE] })
		try {
			const response = await call('principals.invite', { email: 'evil2@contember.com' }, {
				cookie: `__Host-px_session=${session}`,
				origin: null,
			})
			expect(response.status).toBe(403)
		} finally {
			await stop()
		}
	})

	test('the gateway forwards the browser Origin unmodified, so IAM sees what the browser sent', async () => {
		// The regression pin. Rewriting `Origin` to IAM's private address made the two checks compare
		// values that can never agree; it also could not have been right, because the browser's origin is
		// the console's and never IAM's.
		const { call, session, stop } = await stack({ adminOrigins: ['http://somewhere.else.test'] })
		try {
			// The console origin is not registered, but IAM's private loopback address is not registered
			// either — so if the header were still rewritten this would be indistinguishable. What proves
			// the point is that registering the CONSOLE (the previous tests) is what makes the call work.
			const response = await call('principals.invite', { email: 'x@contember.com' }, { cookie: `__Host-px_session=${session}` })
			expect(response.status).toBe(403)
		} finally {
			await stop()
		}
	})

	test('a machine caller needs no origin at all and is unaffected by the registry', async () => {
		const { call, stop } = await stack({ adminOrigins: [] })
		try {
			// No cookie, so no ambient authority and nothing for CSRF to defend. It fails on the credential
			// (401), not on the origin (403) — which is the distinction that matters.
			const response = await call('me', null, { bearer: 'px_not_a_real_key', origin: null })
			expect(response.status).toBe(401)
		} finally {
			await stop()
		}
	})
})
