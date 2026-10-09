/**
 * Every answer the proxy writes itself reaches the client as-is (Caddy returns a non-2xx auth answer verbatim, the
 * Cloudflare Worker returns it directly), so each carries the header policy of ADR-0022 — or, for a download
 * endpoint, the file treatment.
 */

import { describe, expect, test } from 'bun:test'
import { BASE_HEADER_POLICY, FILE_TREATMENT, type HeaderPolicy, headerPolicy } from '../headers'
import type { ProxyApp } from '../manifest'
import { createVerifyService } from '../service'
import { anonymousRow, appWith, contractAppWith, endpointRow, FakeIam, ISSUER, signToken, verifyRequest } from './helpers'

const ME = endpointRow({
	id: 'api.me',
	kind: 'query',
	method: 'GET',
	path: '/api/me',
	callers: ['human'],
	requirement: { kind: 'member' },
	admission: null,
})
const DOWNLOAD = endpointRow({
	id: 'files.avatar.download',
	kind: 'download',
	method: 'GET',
	path: '/api/files.avatar/:fileId',
	callers: ['human'],
	requirement: { kind: 'action', action: 'files.read', access: { form: 'on', dimension: 'file', from: 'fileId' } },
	admission: null,
})
const HEALTH = anonymousRow({ id: 'health', kind: 'health', method: 'GET', path: '/healthz', admission: null })

const CSP = { connectSrc: ['https://api.maps.example'], imgSrc: [], frameAncestors: ['https://portal.example'] }
const OPERATIONS = 'https://operations.example.com'
const CONTRACT = contractAppWith([ME, DOWNLOAD, HEALTH], ['/api'], { csp: CSP, operationsOrigin: OPERATIONS })
const POLICY = headerPolicy(CSP, OPERATIONS)

function verifyWith(iam: FakeIam, app: ProxyApp = CONTRACT) {
	return createVerifyService({ manifest: { apps: [app] }, iam, issuer: ISSUER })
}

function expectHeaders(response: Response, policy: HeaderPolicy): void {
	for (const [name, value] of policy) {
		expect(response.headers.get(name)).toBe(value)
	}
}

describe('a contract application', () => {
	test('a denial carries its policy, with its named origins and the Operations ingest', async () => {
		const response = await verifyWith(new FakeIam())(verifyRequest({ path: '/api/unknown' }))
		expect(response.status).toBe(403)
		expectHeaders(response, POLICY)
		expect(response.headers.get('Content-Security-Policy')).toContain(
			"connect-src 'self' https://operations.example.com https://api.maps.example;",
		)
		expect(response.headers.get('Content-Security-Policy')).toContain('frame-ancestors https://portal.example')
	})

	test('the login answers carry it: the 401 envelope and the 302 bounce', async () => {
		const verify = verifyWith(new FakeIam())
		const envelope = await verify(verifyRequest({ path: '/api/me', headers: { 'Sec-Fetch-Mode': 'cors' } }))
		expect(envelope.status).toBe(401)
		expectHeaders(envelope, POLICY)
		const bounce = await verify(verifyRequest({ path: '/api/me', headers: { 'Sec-Fetch-Mode': 'navigate' } }))
		expect(bounce.status).toBe(302)
		expectHeaders(bounce, POLICY)
		// The policy is added; the bounce keeps its own headers.
		expect(bounce.headers.get('Location')).not.toBeNull()
		expect(bounce.headers.get('Set-Cookie')).not.toBeNull()
	})

	test('a denial of a download endpoint gets the file treatment instead of the policy', async () => {
		const iam = new FakeIam({ mintToken: { ok: true, token: await signToken({ type: 'user', permissions: [] }), expiresAt: 4_102_444_800 } })
		const response = await verifyWith(iam)(verifyRequest({ path: '/api/files.avatar/f1', cookie: '__Host-px_session=s' }))
		expect(response.status).toBe(403)
		expectHeaders(response, FILE_TREATMENT)
		expect(response.headers.get('Content-Disposition')).toBe('attachment')
		expect(response.headers.get('Permissions-Policy')).toBeNull()
	})

	test('an allow carries no policy: it answers Caddy, never the client', async () => {
		const response = await verifyWith(new FakeIam())(verifyRequest({ path: '/healthz' }))
		expect(response.status).toBe(204)
		expect(response.headers.get('Content-Security-Policy')).toBeNull()
	})
})

describe('an answer that belongs to no contract application', () => {
	test("a gate app's denial carries the base policy", async () => {
		const verify = verifyWith(new FakeIam(), appWith({ rules: [{ path: '/*', kind: 'service' }] }))
		const response = await verify(verifyRequest({ path: '/x' }))
		expect(response.status).toBe(401)
		expectHeaders(response, BASE_HEADER_POLICY)
	})

	test('a forward refused before an app is selected carries the base policy: a missing method, a non-canonical path', async () => {
		const verify = verifyWith(new FakeIam())
		const unread = await verify(verifyRequest({ method: null }))
		expect(unread.status).toBe(403)
		expectHeaders(unread, BASE_HEADER_POLICY)
		const nonCanonical = await verify(verifyRequest({ path: '/api//me' }))
		expect(nonCanonical.status).toBe(400)
		expectHeaders(nonCanonical, BASE_HEADER_POLICY)
	})

	test('a request to no service path or with another method than GET is refused with the base policy', async () => {
		const verify = verifyWith(new FakeIam())
		const unknown = await verify(new Request('https://proxy.internal/elsewhere'))
		expect(unknown.status).toBe(404)
		expectHeaders(unknown, BASE_HEADER_POLICY)
		const posted = await verify(new Request('https://proxy.internal/verify', { method: 'POST' }))
		expect(posted.status).toBe(405)
		expectHeaders(posted, BASE_HEADER_POLICY)
	})
})

describe('the OAuth metadata path', () => {
	test("a contract application has no metadata: the refusal carries the application's policy", async () => {
		const response = await verifyWith(new FakeIam())(verifyRequest({ endpoint: '/oauth-metadata', path: '/.well-known/oauth-protected-resource' }))
		expect(response.status).toBe(404)
		expectHeaders(response, POLICY)
	})
})
