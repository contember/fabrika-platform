/**
 * The console's Access plane, end to end across the seam that actually broke.
 *
 * The unit tests on either side of this seam were once green while production answered every call to
 * `/iam/admin/*` with 403. The current boundary adds another cross-package invariant: the app session
 * stops at the proxy, Control forwards the proxy-injected app JWT as a bearer, and IAM verifies its
 * identity but resolves IAM permissions live. This test drives `forwardIamAdmin` through the real
 * `HttpIamAdminGateway` over a real HTTP hop into the real IAM application, with the three coordinates
 * a live installation actually has:
 *
 *   the console's public origin  ≠  IAM's public issuer  ≠  IAM's private RPC address
 *
 * It lives OUTSIDE `src/` for the same reason `proxy-gates.test.ts` does: `tsconfig.json` includes
 * `src/**` only, so reaching across into two other packages never enters this package's program.
 */

import { PROXY_TOKEN_HEADER } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { forwardIamAdmin } from '../../control/src/iam-admin'
import { HttpIamAdminGateway } from '../../control/src/node/iam-admin'
import { createHarness, seedGrant, seedUser } from '../../iam/src/__tests__/helpers/harness'
import { createIamApp } from '../../iam/src/app'
import type { Env } from '../../iam/src/env'
import { mintToken } from '../../iam/src/tokens'

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
	call(
		method: string,
		input: unknown,
		options?: { origin?: string | null; cookie?: string; bearer?: string; proxyToken?: string | null },
	): Promise<Response>
	stop(): Promise<void>
}

/** Compose control's gateway in front of IAM over a real socket. */
async function stack(options: { adminOrigins: string[] }): Promise<Stack> {
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
		ENVIRONMENT: 'local',
		ISSUER,
		FABRIKA_IAM_SIGNING_KEYS: '',
		FABRIKA_IAM_PROVISIONING_KEY: '',
		OIDC_ISSUER: 'https://idp.test',
		OIDC_CLIENT_ID: 'client',
		OIDC_CLIENT_SECRET: 'secret',
		OIDC_SCOPES: '',
		OIDC_REQUIRE_VERIFIED_EMAIL: 'true',
	}
	const services = harness.makeServices({ environment: 'local', issuer: ISSUER, adminOrigins: options.adminOrigins })
	const minted = await mintToken(services, env, { app: 'vozka', session, requestId: 'r1' })
	if (!minted.result.ok) throw new Error(`proxy token mint failed: ${minted.result.reason}`)
	const proxyToken = minted.result.token

	const iam = createIamApp()
	// IAM's PRIVATE address. A loopback port on plain HTTP, which is what a private service binding or
	// a `FABRIKA_IAM_RPC_URL` looks like — and what the old code substituted for the browser's origin.
	const server = Bun.serve({ port: 0, fetch: (request) => iam.fetch(request, env, { waitUntil() {} }) })
	const gateway = new HttpIamAdminGateway(`http://127.0.0.1:${server.port}`)

	return {
		call(method, input, callOptions = {}) {
			const headers = new Headers({ 'content-type': 'application/json' })
			const origin = callOptions.origin === undefined ? CONSOLE : callOptions.origin
			if (origin !== null) headers.set('origin', origin)
			if (callOptions.cookie !== undefined) headers.set('cookie', callOptions.cookie)
			if (callOptions.bearer !== undefined) headers.set('authorization', `Bearer ${callOptions.bearer}`)
			if (callOptions.proxyToken !== null) headers.set(PROXY_TOKEN_HEADER, proxyToken)
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
		const { call, stop } = await stack({ adminOrigins: [CONSOLE] })
		try {
			const response = await call('me', null)
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
		const { call, stop } = await stack({ adminOrigins: [CONSOLE] })
		try {
			const response = await call('principals.invite', { email: 'invited@contember.com' })
			expect(response.status).toBe(200)
			expect(JSON.stringify(await response.json())).toContain('invited@contember.com')
		} finally {
			await stop()
		}
	})

	test('IAM does not apply its cookie-origin registry to a proxy-authenticated private hop', async () => {
		const { call, stop } = await stack({ adminOrigins: [] })
		try {
			const response = await call('principals.invite', { email: 'allowed@contember.com' })
			expect(response.status).toBe(200)
		} finally {
			await stop()
		}
	})

	test('a hostile cross-origin POST is stopped by the DEPUTY, before IAM is asked', async () => {
		// The confused-deputy attack: a hostile page POSTs to the console's own origin and the browser
		// attaches ambient cookies by itself. Control's own same-origin check refuses it, so the request
		// never reaches the gateway — which is what makes the transport-only design safe.
		const { call, stop } = await stack({ adminOrigins: [CONSOLE] })
		try {
			const response = await call('principals.invite', { email: 'evil@contember.com' }, {
				cookie: 'console_state=ambient',
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
		const { call, stop } = await stack({ adminOrigins: [CONSOLE] })
		try {
			const response = await call('principals.invite', { email: 'evil2@contember.com' }, {
				cookie: 'console_state=ambient',
				origin: null,
			})
			expect(response.status).toBe(403)
		} finally {
			await stop()
		}
	})

	test('IAM authority comes from the proxy token, not a forwarded app session', async () => {
		const { call, stop } = await stack({ adminOrigins: ['http://somewhere.else.test'] })
		try {
			const response = await call('principals.invite', { email: 'x@contember.com' }, { cookie: 'app_cookie=not-forwarded' })
			expect(response.status).toBe(200)
		} finally {
			await stop()
		}
	})

	test('a machine caller needs no origin at all and is unaffected by the registry', async () => {
		const { call, stop } = await stack({ adminOrigins: [] })
		try {
			// No cookie, so no ambient authority and nothing for CSRF to defend. It fails on the credential
			// (401), not on the origin (403) — which is the distinction that matters.
			const response = await call('me', null, { bearer: 'px_not_a_real_key', origin: null, proxyToken: null })
			expect(response.status).toBe(401)
		} finally {
			await stop()
		}
	})
})
