/**
 * The cross-origin truth table (ADR-0022 "Cross-origin endpoints"): the preflight of every endpoint kind, the answer an
 * admitted origin reads, and the session a listed origin never spends. A missing row here is an origin let in.
 */

import {
	type BodyAdmission,
	ENDPOINT_HEADER,
	type MintTokenResult,
	type PermissionEntry,
	requirementDigest,
	type TokenPrincipalType,
} from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { MemoryTokenCache } from '../cache'
import { PREFLIGHT_HEADER, PROXY_TOKEN_HEADER } from '../constants'
import { parseProxyManifest, type ProxyEndpointRow } from '../manifest'
import { createVerifyService, type VerifyService } from '../service'
import {
	anonymousRow,
	contractAppWith,
	endpointRow,
	FakeIam,
	type FakeIamOptions,
	HOST,
	ISSUER,
	manifestWith,
	protocolRow,
	signToken,
	verifyRequest,
	type VerifyRequestOptions,
} from './helpers'

const JSON_BODY: BodyAdmission = { contentTypes: ['application/json'], maxBytes: 65_536 }
const PARTNER = 'https://partner.example'
const STRANGER = 'https://stranger.example'

const OPEN = endpointRow({
	id: 'api.me',
	kind: 'query',
	method: 'POST',
	path: '/api/me',
	callers: ['human', 'machine'],
	requirement: { kind: 'member' },
	admission: JSON_BODY,
	crossOrigin: 'environment',
})
const CLOSED = endpointRow({
	id: 'api.notes.list',
	kind: 'query',
	method: 'POST',
	path: '/api/notes.list',
	callers: ['human', 'machine'],
	requirement: { kind: 'member' },
	admission: JSON_BODY,
})
const SIGNUP = anonymousRow({ id: 'signup', kind: 'form', method: 'POST', path: '/signup', admission: JSON_BODY, crossOrigin: 'any' })
const CONTACT = anonymousRow({ id: 'contact', kind: 'form', method: 'POST', path: '/contact', admission: JSON_BODY, crossOrigin: 'environment' })
const SPA = endpointRow({ id: 'web', kind: 'spa', method: 'GET', path: '/*', callers: ['human'], requirement: { kind: 'member' }, admission: null })
const DOWNLOAD = endpointRow({
	id: 'files.download',
	kind: 'download',
	method: 'GET',
	path: '/files/:id',
	callers: ['human'],
	requirement: { kind: 'member' },
	admission: null,
})
const UPLOAD = endpointRow({
	id: 'files.upload',
	kind: 'upload',
	method: 'POST',
	path: '/files',
	callers: ['human'],
	requirement: { kind: 'member' },
	admission: { contentTypes: ['image/png'], maxBytes: 1024 },
})
const HEALTH = anonymousRow({ id: 'health', kind: 'health', method: 'GET', path: '/healthz', admission: null })
const HOOK = anonymousRow({ id: 'hook', kind: 'webhook', method: 'POST', path: '/hooks/:binding', admission: JSON_BODY })
const SHELL = anonymousRow({ id: 'shared', kind: 'link-spa', method: 'GET', path: '/s/*', admission: null })
const FEEDBACK = anonymousRow({ id: 'feedback', kind: 'form', method: 'POST', path: '/feedback', admission: JSON_BODY })
/** Forms that take files: `multipart/form-data`, which a browser sends from any page without a preflight. */
const MULTIPART: BodyAdmission = { contentTypes: ['multipart/form-data'], maxBytes: 4096 }
const REGISTER = anonymousRow({ id: 'register', kind: 'form', method: 'POST', path: '/register', admission: MULTIPART, crossOrigin: 'environment' })
const APPLY = anonymousRow({ id: 'apply', kind: 'form', method: 'POST', path: '/apply', admission: MULTIPART })
const EMBED = anonymousRow({ id: 'embed', kind: 'form', method: 'POST', path: '/embed', admission: MULTIPART, crossOrigin: 'any' })

const TABLE = [OPEN, CLOSED, SIGNUP, CONTACT, SPA, DOWNLOAD, UPLOAD, HEALTH, HOOK, SHELL, FEEDBACK, REGISTER, APPLY, EMBED]
const RESERVED = ['/api']

const future = (seconds = 300) => Math.floor(Date.now() / 1000) + seconds
const grant = (action: string): PermissionEntry => ({ action, scope: null, source: 'grant' })
const SESSION = '__Host-px_session=s'

async function minted(type: TokenPrincipalType): Promise<Extract<MintTokenResult, { ok: true }>> {
	return { ok: true, token: await signToken({ type, permissions: [grant('notes.read')] }), expiresAt: future() }
}

function service(options: FakeIamOptions, crossOrigins: [string, ...string[]] | null = [PARTNER]): { iam: FakeIam; verify: VerifyService } {
	const iam = new FakeIam(options)
	const app = contractAppWith(TABLE, RESERVED, crossOrigins === null ? {} : { crossOrigins })
	const manifest = parseProxyManifest({ apps: [app] })
	if (manifest === null) throw new Error('the cross-origin manifest does not parse')
	return { iam, verify: createVerifyService({ manifest, iam, issuer: ISSUER, cache: new MemoryTokenCache() }) }
}

/** What a browser sends before a cross-origin `fetch` with `Authorization` or a JSON body. */
function preflight(path: string, origin: string, method = 'POST'): VerifyRequestOptions {
	return {
		method: 'OPTIONS',
		path,
		headers: { Origin: origin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization,content-type' },
	}
}

/** A cross-origin call: no `Sec-Fetch-Site: same-origin`, an `Origin`, a JSON body. */
function call(path: string, origin: string, extra: Partial<VerifyRequestOptions> = {}): VerifyRequestOptions {
	return { method: 'POST', path, ...extra, headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' } }
}

function expectRefusedPreflight(response: Response): void {
	expect(response.status).toBe(403)
	expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
	expect(response.headers.get(PREFLIGHT_HEADER)).toBeNull()
}

describe('the preflight, decided before any credential', () => {
	test('a listed origin on an endpoint open to the environment is answered by the proxy, with no IAM call', async () => {
		const { iam, verify } = service({ mintToken: await minted('user') })
		const response = await verify(verifyRequest({ ...preflight('/api/me', PARTNER), cookie: SESSION }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PREFLIGHT_HEADER)).toBe('1')
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PARTNER)
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST')
		expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Authorization, Content-Type')
		expect(response.headers.get('Access-Control-Max-Age')).toBe('600')
		expect(response.headers.get('Vary')).toBe('Origin')
		expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
		// The proxy's own answer carries the application's policy, like every other.
		expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'")
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
		expect(response.headers.get(ENDPOINT_HEADER)).toBeNull()
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls + iam.jwksCalls).toBe(0)
	})

	test('an origin the environment does not list is refused', async () => {
		const { verify } = service({})
		expectRefusedPreflight(await verify(verifyRequest(preflight('/api/me', STRANGER))))
		expectRefusedPreflight(await verify(verifyRequest(preflight('/api/me', 'null'))))
		expectRefusedPreflight(await verify(verifyRequest(preflight('/api/me', `${PARTNER}:8443`))))
		expectRefusedPreflight(await verify(verifyRequest(preflight('/api/me', PARTNER.replace('https:', 'http:')))))
	})

	test('an environment that lists no origin opens no endpoint, whatever its contract says', async () => {
		const { verify } = service({}, null)
		expectRefusedPreflight(await verify(verifyRequest(preflight('/api/me', PARTNER))))
		expectRefusedPreflight(await verify(verifyRequest(preflight('/contact', PARTNER))))
	})

	test.each<[string, ProxyEndpointRow, string]>([
		['an RPC procedure without crossOrigin', CLOSED, '/api/notes.list'],
		['an SPA', SPA, '/index.html'],
		['a download', DOWNLOAD, '/files/1'],
		['an upload', UPLOAD, '/files'],
		['a health endpoint', HEALTH, '/healthz'],
		['a webhook', HOOK, '/hooks/github'],
		['a link shell', SHELL, '/s/abc'],
		['a form without crossOrigin', FEEDBACK, '/feedback'],
	])('%s answers no preflight, from a listed origin either', async (_name, row, path) => {
		const { verify } = service({})
		expectRefusedPreflight(await verify(verifyRequest(preflight(path, PARTNER, row.method))))
	})

	test('the requested method selects: a GET of a POST procedure is no endpoint', async () => {
		const { verify } = service({})
		expectRefusedPreflight(await verify(verifyRequest(preflight('/api/me', PARTNER, 'GET'))))
		expectRefusedPreflight(await verify(verifyRequest(preflight('/api/me', PARTNER, 'post'))))
	})

	test('an unknown path under a reserved prefix falls through to nothing', async () => {
		const { verify } = service({})
		expectRefusedPreflight(await verify(verifyRequest(preflight('/api/unknown', PARTNER))))
	})

	test('a form open to any origin admits every origin, as `*` and without Vary', async () => {
		const { verify } = service({}, null)
		const response = await verify(verifyRequest(preflight('/signup', STRANGER)))
		expect(response.status).toBe(204)
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
		expect(response.headers.get('Vary')).toBeNull()
	})

	test("a form open to the environment admits only the environment's origins", async () => {
		const { verify } = service({})
		expect((await verify(verifyRequest(preflight('/contact', PARTNER)))).headers.get('Access-Control-Allow-Origin')).toBe(PARTNER)
		expectRefusedPreflight(await verify(verifyRequest(preflight('/contact', STRANGER))))
	})

	test('an OPTIONS that is no preflight selects no endpoint', async () => {
		const { verify } = service({})
		expectRefusedPreflight(await verify(verifyRequest({ method: 'OPTIONS', path: '/api/me', headers: { Origin: PARTNER } })))
		expectRefusedPreflight(await verify(verifyRequest({ method: 'OPTIONS', path: '/api/me', headers: { 'Access-Control-Request-Method': 'POST' } })))
	})

	test('a non-canonical path is a 400 before the preflight is planned', async () => {
		const { verify } = service({})
		expect((await verify(verifyRequest(preflight('/api//me', PARTNER)))).status).toBe(400)
	})

	test('an installation entry has no cross-origin form: its `*` row serves the OPTIONS as any other request', async () => {
		const iam = new FakeIam({})
		const verify = createVerifyService({ manifest: manifestWith([protocolRow('/auth/login')]), iam, issuer: ISSUER })
		const response = await verify(verifyRequest(preflight('/auth/login', PARTNER)))
		expect(response.status).toBe(204)
		expect(response.headers.get(PREFLIGHT_HEADER)).toBeNull()
		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
	})
})

describe('the answer to an admitted cross-origin request', () => {
	test('a key from a listed origin is allowed, and the allow tells the composition which origin to admit', async () => {
		const { verify } = service({ mintFromKey: await minted('service') })
		const response = await verify(verifyRequest(call('/api/me', PARTNER, { bearer: 'px_machine' })))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).not.toBeNull()
		expect(response.headers.get(PREFLIGHT_HEADER)).toBeNull()
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PARTNER)
		expect(response.headers.get('Vary')).toBe('Origin')
	})

	test("a person's own key crosses origins as that person", async () => {
		const { verify } = service({ mintFromKey: await minted('user') })
		const response = await verify(verifyRequest(call('/api/me', PARTNER, { bearer: 'px_person' })))
		expect(response.status).toBe(204)
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PARTNER)
	})

	test("a refused key's denial carries the origin too, so the page can read why", async () => {
		const { verify } = service({ mintFromKey: { ok: false, reason: 'invalid_key' } })
		const response = await verify(verifyRequest(call('/api/me', PARTNER, { bearer: 'px_bad' })))
		expect(response.status).toBe(401)
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PARTNER)
		expect(response.headers.get('Access-Control-Allow-Credentials')).toBeNull()
	})

	test('an unlisted origin, or an endpoint the contract keeps closed, gets no origin header', async () => {
		const { verify } = service({ mintFromKey: await minted('service') })
		const stranger = await verify(verifyRequest(call('/api/me', STRANGER, { bearer: 'px_machine' })))
		expect(stranger.status).toBe(204)
		expect(stranger.headers.get('Access-Control-Allow-Origin')).toBeNull()
		const closed = await verify(verifyRequest(call('/api/notes.list', PARTNER, { bearer: 'px_machine' })))
		expect(closed.status).toBe(204)
		expect(closed.headers.get('Access-Control-Allow-Origin')).toBeNull()
	})

	test('a form open to any origin is forwarded with `*`', async () => {
		const { verify } = service({})
		const response = await verify(verifyRequest(call('/signup', STRANGER)))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
	})
})

describe('a multipart form, which a browser sends without a preflight', () => {
	/** What a page's `fetch` of a FormData sends: no preflight, its `Origin`, a multipart body. */
	const upload = (path: string, origin: string | null, site = 'cross-site'): VerifyRequestOptions => ({
		method: 'POST',
		path,
		headers: {
			...(origin === null ? {} : { Origin: origin }),
			'Content-Type': 'multipart/form-data; boundary=x',
			'Sec-Fetch-Site': site,
		},
	})

	test("is refused from an origin its row does not admit, as a JSON form's preflight is", async () => {
		const { iam, verify } = service({})
		for (const [path, origin] of [['/register', STRANGER], ['/register', 'null'], ['/apply', PARTNER], ['/apply', STRANGER]] as const) {
			const response = await verify(verifyRequest(upload(path, origin)))
			expect(response.status).toBe(403)
			expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
		}
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls + iam.jwksCalls).toBe(0)
	})

	test("is forwarded from the application's own page, from a listed origin, without Origin, and on a row open to any", async () => {
		const { verify } = service({})
		const own = await verify(verifyRequest(upload('/apply', `https://${HOST}`, 'same-origin')))
		expect(own.status).toBe(204)
		expect(own.headers.get('Access-Control-Allow-Origin')).toBeNull()
		const listed = await verify(verifyRequest(upload('/register', PARTNER)))
		expect(listed.status).toBe(204)
		expect(listed.headers.get('Access-Control-Allow-Origin')).toBe(PARTNER)
		expect((await verify(verifyRequest(upload('/apply', null)))).status).toBe(204)
		const any = await verify(verifyRequest(upload('/embed', STRANGER)))
		expect(any.status).toBe(204)
		expect(any.headers.get('Access-Control-Allow-Origin')).toBe('*')
	})

	test('admits only its own media type: a JSON body to a multipart form is a 400', async () => {
		const { verify } = service({})
		expect((await verify(verifyRequest(call('/register', PARTNER)))).status).toBe(400)
	})
})

describe('a session never crosses origins', () => {
	test('a listed origin with only the session cookie is a 401, the cookie unread and no login bounce', async () => {
		const { iam, verify } = service({ mintToken: await minted('user') })
		for (const fetchSite of ['cross-site', 'same-site', 'same-origin']) {
			const request = call('/api/me', PARTNER, { cookie: SESSION })
			const response = await verify(verifyRequest({ ...request, headers: { ...request.headers, 'Sec-Fetch-Site': fetchSite } }))
			expect(response.status).toBe(401)
			expect(response.headers.get('Content-Type')).toStartWith('text/plain')
			expect(response.headers.get('Set-Cookie')).toBeNull()
			expect(response.headers.get('Access-Control-Allow-Origin')).toBe(PARTNER)
		}
		expect(iam.mintTokenCalls).toBe(0)
	})

	test("the same session from the application's own page still works, and from an unlisted origin is refused as today", async () => {
		const { verify } = service({ mintToken: await minted('user') })
		const own = await verify(
			verifyRequest({
				method: 'POST',
				path: '/api/me',
				cookie: SESSION,
				headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', Origin: `https://${HOST}` },
			}),
		)
		expect(own.status).toBe(204)
		expect(own.headers.get('Access-Control-Allow-Origin')).toBeNull()
		const stranger = await verify(verifyRequest(call('/api/me', STRANGER, { cookie: SESSION })))
		expect(stranger.status).toBe(403)
		expect(stranger.headers.get('Access-Control-Allow-Origin')).toBeNull()
	})
})

describe('the manifest holds both halves apart', () => {
	const app = (fields: Record<string, unknown>) => ({ ...contractAppWith([OPEN], RESERVED), ...fields })

	test('an environment lists exact origins, each once, never its own host, at most sixteen', () => {
		expect(parseProxyManifest({ apps: [app({ crossOrigins: [PARTNER, 'http://localhost:5173'] })] })).not.toBeNull()
		for (
			const crossOrigins of [
				[],
				['https://*.example'],
				['https://partner.example/'],
				['https://partner.example/path'],
				['https://user@partner.example'],
				['null'],
				['*'],
				['ftp://partner.example'],
				[PARTNER, PARTNER],
				[`https://${HOST}`],
				Array.from({ length: 17 }, (_, index) => `https://p${index}.example`),
			]
		) {
			expect(parseProxyManifest({ apps: [app({ crossOrigins })] })).toBeNull()
		}
	})

	test('no installation entry carries origins, and no installation row a cross-origin form', () => {
		const entry = manifestWith([protocolRow('/auth/login')]).apps[0]
		expect(parseProxyManifest({ apps: [{ ...entry, crossOrigins: [PARTNER] }] })).toBeNull()
		const row = { ...protocolRow('/auth/login'), crossOrigin: 'any' }
		expect(parseProxyManifest({ apps: [{ ...entry, endpoints: [row] }] })).toBeNull()
	})

	test.each<[string, ProxyEndpointRow, 'environment' | 'any']>([
		['an SPA', SPA, 'environment'],
		['a download', DOWNLOAD, 'environment'],
		['an upload', UPLOAD, 'environment'],
		['a health endpoint', HEALTH, 'environment'],
		['a webhook', HOOK, 'environment'],
		['a link shell', SHELL, 'any'],
		['an RPC procedure, to any origin', CLOSED, 'any'],
	])('%s cannot be opened (%s)', (_name, row, crossOrigin) => {
		// The digest describes the opened row, so only the kind's rule can refuse it.
		const rules = { ...row, crossOrigin }
		expect(parseProxyManifest({ apps: [app({ endpoints: [{ ...rules, digest: requirementDigest(rules) }] })] })).toBeNull()
	})

	test('a row whose cross-origin form changed under its digest is refused', () => {
		expect(parseProxyManifest({ apps: [app({ endpoints: [{ ...CLOSED, crossOrigin: 'environment' }] })] })).toBeNull()
		expect(parseProxyManifest({ apps: [app({ endpoints: [{ ...OPEN, crossOrigin: undefined }] })] })).toBeNull()
	})
})
