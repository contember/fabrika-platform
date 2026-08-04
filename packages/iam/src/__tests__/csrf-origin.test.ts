// The admin CSRF guard (backlog 50).
//
// Both properties here were live defects on the Zerops installation: a real browser could not write
// anything, and no machine caller could either. The unit under test is deliberately `rejectCrossOrigin`
// itself, because both failures were about which origin it compares against — not about routing.

import { describe, expect, test } from 'bun:test'
import { rejectCrossOrigin } from '../admin/router'

const CONFIG = { issuer: 'https://iam.example.com' }

function request(options: { method?: string; origin?: string; referer?: string; bearer?: boolean; session?: boolean } = {}): Request {
	const headers = new Headers()
	if (options.origin !== undefined) headers.set('Origin', options.origin)
	if (options.referer !== undefined) headers.set('Referer', options.referer)
	if (options.bearer === true) headers.set('Authorization', 'Bearer px_machine_key')
	if (options.session === true) headers.set('Cookie', 'px_session=abc')
	// The URL is what the PROCESS sees. Behind a TLS-terminating balancer that is plain HTTP, which is
	// exactly the case the guard used to get wrong.
	return new Request('http://iam.example.com/admin/principals', { method: options.method ?? 'POST', headers })
}

describe('rejectCrossOrigin', () => {
	test("accepts the browser's https Origin even though the process was reached over http", async () => {
		expect(rejectCrossOrigin(request({ origin: 'https://iam.example.com', session: true }), CONFIG)).toBeNull()
	})

	test('still rejects a genuinely cross-site origin', async () => {
		for (const origin of ['https://evil.example.com', 'https://iam.example.com.evil.test', 'null']) {
			const response = rejectCrossOrigin(request({ origin, session: true }), CONFIG)
			expect(response?.status).toBe(403)
		}
	})

	test('rejects the http form of its own host — the browser never sends that for an https origin', async () => {
		// Accepting it would let a network attacker who can serve plain HTTP on the same host forge writes.
		expect(rejectCrossOrigin(request({ origin: 'http://iam.example.com', session: true }), CONFIG)?.status).toBe(403)
	})

	test('falls back to Referer with the same rule', async () => {
		expect(rejectCrossOrigin(request({ referer: 'https://iam.example.com/console', session: true }), CONFIG)).toBeNull()
		expect(rejectCrossOrigin(request({ referer: 'https://evil.example.com/x', session: true }), CONFIG)?.status).toBe(403)
	})

	test('a bearer-only request needs no origin at all', async () => {
		// CSRF is an ambient-authority attack; a bearer is never attached by the browser on its own. This
		// is the documented CI / provisioning path, including the first-administrator bootstrap.
		expect(rejectCrossOrigin(request({ bearer: true }), CONFIG)).toBeNull()
	})

	test('a bearer alongside a session cookie is STILL checked', async () => {
		// Ambient authority is present, so the defense applies regardless of what else is attached.
		expect(rejectCrossOrigin(request({ bearer: true, session: true }), CONFIG)?.status).toBe(403)
		expect(rejectCrossOrigin(request({ bearer: true, session: true, origin: 'https://iam.example.com' }), CONFIG)).toBeNull()
	})

	test('a cookie-authenticated state change with no Origin and no Referer is rejected', async () => {
		expect(rejectCrossOrigin(request({ session: true }), CONFIG)?.status).toBe(403)
	})

	test('safe methods are never blocked', async () => {
		for (const method of ['GET', 'HEAD']) {
			expect(rejectCrossOrigin(request({ method, origin: 'https://evil.example.com' }), CONFIG)).toBeNull()
		}
	})

	test('an unusable configured issuer fails closed rather than accepting anything', async () => {
		expect(rejectCrossOrigin(request({ origin: 'https://iam.example.com', session: true }), { issuer: '' })?.status).toBe(403)
	})
})
