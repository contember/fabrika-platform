/**
 * Every answer the proxy writes itself reaches the client as-is (Caddy returns a non-2xx auth answer verbatim, the
 * Cloudflare Worker returns it directly), so each carries the header policy of ADR-0022 — or, for a download
 * endpoint, the file treatment.
 */

import { describe, expect, test } from 'bun:test'
import {
	appFileTreatment,
	appHeaderPolicy,
	applyFileTreatment,
	applyHeaderPolicy,
	BASE_HEADER_POLICY,
	type CspOrigins,
	FILE_TREATMENT,
	type HeaderPolicy,
	headerPolicy,
} from '../headers'
import type { ProxyApp } from '../manifest'
import { createVerifyService } from '../service'
import { anonymousRow, contractAppWith, endpointRow, FakeIam, installationAppWith, ISSUER, serviceRow, signToken, verifyRequest } from './helpers'

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

const CSP = { connectSrc: ['https://api.maps.example'], imgSrc: [], frameAncestors: ['https://portal.example'], scriptSrc: [], frameSrc: [] }
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

describe('the CSP of named script and frame origins', () => {
	const widget = 'https://challenges.cloudflare.com'

	test('a declared script origin joins script-src, and a declared frame origin is the only way frame-src appears', () => {
		const csp = (origins: Partial<CspOrigins>) => headerPolicy({ ...CSP, ...origins }, null).find(([name]) => name === 'Content-Security-Policy')?.[1]
		expect(csp({})).toContain("script-src 'self';")
		expect(csp({}) ?? '').not.toContain('frame-src')
		expect(csp({ scriptSrc: [widget], frameSrc: [widget] })).toContain(`script-src 'self' ${widget};`)
		expect(csp({ scriptSrc: [widget], frameSrc: [widget] })).toEndWith(`; frame-src ${widget}`)
	})
})

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

describe('the transport header of an application host', () => {
	const HSTS = 'max-age=31536000'

	test('every answer of an https host carries HSTS: denials, the login answers and a download denial', async () => {
		const verify = verifyWith(
			new FakeIam({ mintToken: { ok: true, token: await signToken({ type: 'user', permissions: [] }), expiresAt: 4_102_444_800 } }),
		)
		const download = await verify(verifyRequest({ path: '/api/files.avatar/f1', cookie: '__Host-px_session=s' }))
		const answers = [
			await verify(verifyRequest({ path: '/api/unknown' })),
			await verify(verifyRequest({ path: '/api/me', headers: { 'Sec-Fetch-Mode': 'cors' } })),
			await verify(verifyRequest({ path: '/api/me', headers: { 'Sec-Fetch-Mode': 'navigate' } })),
			download,
		]
		expect(answers.map((answer) => answer.status)).toEqual([403, 401, 302, 403])
		for (const answer of answers) {
			expect(answer.headers.get('Strict-Transport-Security')).toBe(HSTS)
		}
		expectHeaders(download, appFileTreatment(CONTRACT))
	})

	test('an http host gets none, and neither does an answer that belongs to no application host', async () => {
		const local = verifyWith(new FakeIam(), { ...CONTRACT, scheme: 'http' })
		expect((await local(verifyRequest({ path: '/api/unknown' }))).headers.get('Strict-Transport-Security')).toBeNull()
		const installation = verifyWith(new FakeIam(), installationAppWith([serviceRow('/*', ['machine'])]))
		expect((await installation(verifyRequest({ path: '/x' }))).headers.get('Strict-Transport-Security')).toBeNull()
		const unknownHost = await verifyWith(new FakeIam())(verifyRequest({ path: '/api//me', host: 'elsewhere.example' }))
		expect(unknownHost.status).toBe(400)
		expect(unknownHost.headers.get('Strict-Transport-Security')).toBeNull()
	})

	test('a refusal before the request is read carries the transport header of the host it names', async () => {
		const verify = verifyWith(new FakeIam())
		const nonCanonical = await verify(verifyRequest({ path: '/api//me' }))
		const unread = await verify(verifyRequest({ method: null }))
		expect([nonCanonical.status, unread.status]).toEqual([400, 403])
		for (const answer of [nonCanonical, unread]) {
			expectHeaders(answer, [...BASE_HEADER_POLICY, ['Strict-Transport-Security', HSTS]])
		}
		const local = verifyWith(new FakeIam(), { ...CONTRACT, scheme: 'http' })
		expect((await local(verifyRequest({ path: '/api//me' }))).headers.get('Strict-Transport-Security')).toBeNull()
	})

	test("the application's own HSTS never survives: an http host's answer and download policies drop it", () => {
		for (const policy of [appHeaderPolicy({ ...CONTRACT, scheme: 'http' }), appFileTreatment({ scheme: 'http' })]) {
			const headers = new Headers({ 'Strict-Transport-Security': 'max-age=999; includeSubDomains' })
			applyHeaderPolicy(headers, policy)
			expect(headers.get('Strict-Transport-Security')).toBeNull()
		}
		const https = new Headers({ 'Strict-Transport-Security': 'max-age=999; includeSubDomains' })
		applyFileTreatment(https, appFileTreatment(CONTRACT))
		expect(https.get('Strict-Transport-Security')).toBe(HSTS)
	})

	test('the policy and the file treatment of an entry add it only for https; the fixed definitions never carry it', () => {
		expect(appHeaderPolicy(CONTRACT)).toContainEqual(['Strict-Transport-Security', HSTS])
		expect(appFileTreatment(CONTRACT)).toContainEqual(['Strict-Transport-Security', HSTS])
		expect(appHeaderPolicy({ ...CONTRACT, scheme: 'http' })).toEqual(POLICY)
		expect(appFileTreatment({ scheme: 'http' })).toEqual(FILE_TREATMENT)
		expect([...POLICY, ...FILE_TREATMENT, ...BASE_HEADER_POLICY].map(([name]) => name)).not.toContain('Strict-Transport-Security')
	})
})

describe('an answer that belongs to no contract application', () => {
	test("an installation entry's denial carries the base policy", async () => {
		const verify = verifyWith(new FakeIam(), installationAppWith([serviceRow('/*', ['machine'])]))
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
