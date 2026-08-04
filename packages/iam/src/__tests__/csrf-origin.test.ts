// The admin CSRF guard.
//
// Three properties here were live defects on a real installation. Two came from backlog 50: a real
// browser could not write anything, and no machine caller could either. The third is the one this
// sprint found — the guard compared against IAM's own ISSUER, which a console request never carries,
// so the Access plane answered 403 in every deployment whose console lives on its own domain. The
// unit under test is deliberately `rejectCrossOrigin` itself, because all three were about which
// origin it compares against, not about routing.

import { describe, expect, test } from 'bun:test'
import { rejectCrossOrigin } from '../admin/router'

const CONSOLE = 'https://console.example.com'
const CONFIG = { adminOrigins: [CONSOLE] }

function request(
	options: { method?: string; origin?: string; referer?: string; bearer?: boolean; session?: boolean; path?: string } = {},
): Request {
	const headers = new Headers()
	if (options.origin !== undefined) headers.set('Origin', options.origin)
	if (options.referer !== undefined) headers.set('Referer', options.referer)
	if (options.bearer === true) headers.set('Authorization', 'Bearer px_machine_key')
	if (options.session === true) headers.set('Cookie', 'px_session=abc')
	// The URL is what the PROCESS sees. Behind a TLS-terminating balancer that is plain HTTP, which is
	// exactly the case the guard used to get wrong.
	return new Request(`http://iam.example.com${options.path ?? '/admin/principals'}`, { method: options.method ?? 'POST', headers })
}

describe('rejectCrossOrigin', () => {
	test("admits the CONSOLE's origin, which is never IAM's own", async () => {
		// The whole point: the browser sends the console's origin and IAM is told to accept it. Comparing
		// against the issuer (`https://iam.example.com`) refused every genuine console write.
		expect(rejectCrossOrigin(request({ origin: CONSOLE, session: true }), CONFIG)).toBeNull()
	})

	test("accepts the browser's https Origin even though the process was reached over http", async () => {
		expect(rejectCrossOrigin(request({ origin: CONSOLE, session: true }), CONFIG)).toBeNull()
	})

	test("rejects IAM's own origin when it is not registered", async () => {
		// No implicit "the issuer is always fine" rule — the registry is the whole authority.
		expect(rejectCrossOrigin(request({ origin: 'https://iam.example.com', session: true }), CONFIG)?.status).toBe(403)
	})

	test('still rejects a genuinely cross-site origin', async () => {
		for (const origin of ['https://evil.example.com', 'https://console.example.com.evil.test', 'null']) {
			const response = rejectCrossOrigin(request({ origin, session: true }), CONFIG)
			expect(response?.status).toBe(403)
		}
	})

	test('rejects the http form of a registered https origin', async () => {
		// Accepting it would let a network attacker who can serve plain HTTP on the same host forge writes.
		expect(rejectCrossOrigin(request({ origin: 'http://console.example.com', session: true }), CONFIG)?.status).toBe(403)
	})

	test('compares canonically, so a default port and a trailing slash are the same origin', async () => {
		expect(rejectCrossOrigin(request({ origin: 'https://Console.Example.com:443' }), CONFIG)).toBeNull()
		expect(rejectCrossOrigin(request({ referer: 'https://console.example.com/access/principals' }), CONFIG)).toBeNull()
	})

	test('admits any registered origin, not just the first', async () => {
		const config = { adminOrigins: ['https://a.example.com', CONSOLE] }
		expect(rejectCrossOrigin(request({ origin: CONSOLE, session: true }), config)).toBeNull()
		expect(rejectCrossOrigin(request({ origin: 'https://a.example.com', session: true }), config)).toBeNull()
	})

	test('falls back to Referer with the same rule', async () => {
		expect(rejectCrossOrigin(request({ referer: `${CONSOLE}/access`, session: true }), CONFIG)).toBeNull()
		expect(rejectCrossOrigin(request({ referer: 'https://evil.example.com/x', session: true }), CONFIG)?.status).toBe(403)
	})

	test('a bearer-only request needs no origin at all', async () => {
		// CSRF is an ambient-authority attack; a bearer is never attached by the browser on its own. This
		// is the documented CI / provisioning path, including the first-administrator bootstrap.
		expect(rejectCrossOrigin(request({ bearer: true }), CONFIG)).toBeNull()
		// …and it stays exempt with an empty registry, which is what a machine-only installation has.
		expect(rejectCrossOrigin(request({ bearer: true }), { adminOrigins: [] })).toBeNull()
	})

	test('a bearer alongside a session cookie is STILL checked', async () => {
		// Ambient authority is present, so the defense applies regardless of what else is attached.
		expect(rejectCrossOrigin(request({ bearer: true, session: true }), CONFIG)?.status).toBe(403)
		expect(rejectCrossOrigin(request({ bearer: true, session: true, origin: CONSOLE }), CONFIG)).toBeNull()
	})

	test('a cookie-authenticated state change with no Origin and no Referer is rejected', async () => {
		expect(rejectCrossOrigin(request({ session: true }), CONFIG)?.status).toBe(403)
	})

	test('safe methods are never blocked', async () => {
		for (const method of ['GET', 'HEAD', 'OPTIONS']) {
			expect(rejectCrossOrigin(request({ method, origin: 'https://evil.example.com' }), CONFIG)).toBeNull()
		}
	})

	test('PUT is checked — the schema reconcile used to skip the guard entirely', async () => {
		// The method list is an ALLOWLIST of safe methods now, so anything unlisted is checked and a
		// method invented later is fail-closed by default (SEC-29).
		const put = { method: 'PUT', path: '/admin/apps/vozka/schema', session: true }
		expect(rejectCrossOrigin(request({ ...put, origin: 'https://evil.example.com' }), CONFIG)?.status).toBe(403)
		expect(rejectCrossOrigin(request({ ...put, origin: CONSOLE }), CONFIG)).toBeNull()
		// A deploy-time reconcile presents a bearer and no cookie, so it stays exempt.
		expect(rejectCrossOrigin(request({ method: 'PUT', path: '/admin/apps/vozka/schema', bearer: true }), CONFIG)).toBeNull()
	})

	test('an empty registry fails closed rather than accepting anything', async () => {
		expect(rejectCrossOrigin(request({ origin: CONSOLE, session: true }), { adminOrigins: [] })?.status).toBe(403)
	})
})
