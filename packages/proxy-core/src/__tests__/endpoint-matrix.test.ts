/**
 * The endpoint-table truth table (ADR-0022 rule 3): one row per step of the decision a contract application gets.
 * Each test names the step and the answer it must produce. Like `deny-matrix.test.ts`, a missing row is a bypass.
 */

import {
	type BodyAdmission,
	DELEGATION_HEADER,
	ENDPOINT_HEADER,
	formatEndpointHeader,
	type MintTokenResult,
	type PermissionEntry,
	type TokenPrincipalType,
} from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { MemoryTokenCache } from '../cache'
import { PROXY_TOKEN_HEADER } from '../constants'
import type { DelegationIssuer, DelegationRequest } from '../iam'
import { createVerifyService, type VerifyService } from '../service'
import {
	anonymousRow,
	contractAppWith,
	endpointRow,
	FakeIam,
	type FakeIamOptions,
	ISSUER,
	signRawClaims,
	signToken,
	verifyRequest,
	type VerifyRequestOptions,
} from './helpers'

const JSON_BODY: BodyAdmission = { contentTypes: ['application/json'], maxBytes: 65_536 }

const ME = endpointRow({
	id: 'api.me',
	kind: 'query',
	method: 'POST',
	path: '/api/me',
	callers: ['human', 'machine'],
	requirement: { kind: 'member' },
	admission: JSON_BODY,
})
const REMOVE = endpointRow({
	id: 'api.notes.remove',
	kind: 'mutation',
	method: 'POST',
	path: '/api/notes.remove',
	callers: ['human'],
	requirement: { kind: 'action', action: 'notes.delete', access: { form: 'on', dimension: 'note', from: 'id' } },
	admission: JSON_BODY,
})
const INVITE = endpointRow({
	id: 'api.workspaces.invite',
	kind: 'mutation',
	method: 'POST',
	path: '/api/workspaces.invite',
	callers: ['human'],
	requirement: { kind: 'action', action: 'notes.admin', access: { form: 'in', dimension: 'workspace', from: 'workspaceId' } },
	admission: JSON_BODY,
}, 'members')
const IMPORT = endpointRow({
	id: 'machine.import',
	kind: 'mutation',
	method: 'POST',
	path: '/machine/import',
	callers: ['machine'],
	requirement: { kind: 'action', action: 'notes.write', access: { form: 'over', dimension: 'workspace' } },
	admission: JSON_BODY,
})
const CODELISTS = endpointRow({
	id: 'api.codelists.save',
	kind: 'mutation',
	method: 'POST',
	path: '/api/codelists.save',
	callers: ['human'],
	requirement: { kind: 'action', action: 'codelists.manage', access: { form: 'app' } },
	admission: JSON_BODY,
})
const HANDOVER = endpointRow({
	id: 'api.requests.handover',
	kind: 'mutation',
	method: 'POST',
	path: '/api/requests.handover',
	callers: ['human'],
	requirement: {
		kind: 'capabilities',
		capabilities: {
			request: { action: 'requests.handover', access: { form: 'on', dimension: 'request', from: 'requestId' } },
			records: { action: 'records.read', access: { form: 'over', dimension: 'record' } },
		},
	},
	admission: JSON_BODY,
})
const SHARED = endpointRow({
	id: 'shared.note',
	kind: 'query',
	method: 'POST',
	path: '/s/api/note',
	callers: ['link'],
	requirement: { kind: 'action', action: 'notes.read', access: { form: 'on', dimension: 'note', from: null } },
	admission: JSON_BODY,
})
const EXPORTED = endpointRow({
	id: 'products.v1.get',
	kind: 'query',
	method: 'POST',
	path: '/__fabrika/connect/products.v1.get',
	callers: ['app:shop'],
	requirement: { kind: 'action', action: 'notes.read', access: { form: 'over', dimension: 'workspace' } },
	admission: JSON_BODY,
})
// An `app:<id>` caller off an export path: what a manifest must never be able to open.
const PARTNER = endpointRow({
	id: 'partner.list',
	kind: 'query',
	method: 'POST',
	path: '/partner/list',
	callers: ['app:shop'],
	requirement: { kind: 'member' },
	admission: JSON_BODY,
})
const SPA = endpointRow({ id: 'web', kind: 'spa', method: 'GET', path: '/*', callers: ['human'], requirement: { kind: 'member' }, admission: null })
const HEALTH = anonymousRow({ id: 'health', kind: 'health', method: 'GET', path: '/healthz', admission: null })
const CONTACT = anonymousRow({
	id: 'contact',
	kind: 'form',
	method: 'POST',
	path: '/contact',
	admission: { contentTypes: ['application/x-www-form-urlencoded'], maxBytes: 4096 },
})

const TABLE = [ME, REMOVE, INVITE, IMPORT, CODELISTS, HANDOVER, SHARED, EXPORTED, PARTNER, SPA, HEALTH, CONTACT]
const RESERVED = ['/api', '/machine', '/s/api', '/__fabrika/connect', '/partner']

const grant = (action: string, scope: PermissionEntry['scope'] = null): PermissionEntry => ({ action, scope, source: 'grant' })
const future = (seconds = 300) => Math.floor(Date.now() / 1000) + seconds
const SESSION = '__Host-px_session=s'
const JSON_POST: VerifyRequestOptions = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' } }

async function minted(
	type: TokenPrincipalType | undefined,
	permissions: PermissionEntry[] = [grant('notes.read')],
	workload?: string,
): Promise<Extract<MintTokenResult, { ok: true }>> {
	const token = await signToken({ ...(type === undefined ? {} : { type }), ...(workload === undefined ? {} : { workload }), permissions })
	return { ok: true, token, expiresAt: future() }
}

function service(options: FakeIamOptions, delegations?: DelegationIssuer | null): { iam: FakeIam; verify: VerifyService } {
	const iam = new FakeIam(options)
	const verify = createVerifyService({
		manifest: { apps: [contractAppWith(TABLE, RESERVED)] },
		iam,
		issuer: ISSUER,
		cache: new MemoryTokenCache(),
		...(delegations === undefined ? {} : { delegations }),
	})
	return { iam, verify }
}

function expectDenied(response: Response, status: number): void {
	expect(response.status).toBe(status)
	expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
	expect(response.headers.get(ENDPOINT_HEADER)).toBeNull()
}

class FakeDelegations implements DelegationIssuer {
	readonly seen: DelegationRequest[] = []
	constructor(private readonly answer: 'grant' | 'refuse' | 'throw') {}

	requestDelegation(input: DelegationRequest): ReturnType<DelegationIssuer['requestDelegation']> {
		this.seen.push(input)
		if (this.answer === 'throw') return Promise.reject(new Error('connect ECONNREFUSED'))
		return Promise.resolve(
			this.answer === 'grant' ? { ok: true, grant: `grant-${this.seen.length}`, expiresAt: future(120) } : { ok: false, reason: 'not_allowed' },
		)
	}
}

describe('step 1 — the raw path is canonical', () => {
	test.each(['/api//me', '/api/./me', '/api/%2e%2e/me', '/api%2fme'])('%s is a 400 before any endpoint is selected', async (path) => {
		const { iam, verify } = service({})
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path, cookie: SESSION })), 400)
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls).toBe(0)
	})

	test('a request without a method is denied', async () => {
		const { verify } = service({})
		expectDenied(await verify(verifyRequest({ path: '/healthz', method: null })), 403)
	})
})

describe('step 2 — selection', () => {
	test('a path no endpoint serves is a 403, under a reserved prefix too: an unknown procedure never reaches the SPA', async () => {
		const { iam, verify } = service({ mintToken: await minted('user') })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/unknown', cookie: SESSION })), 403)
		expectDenied(await verify(verifyRequest({ path: '/api/unknown', cookie: SESSION })), 403)
		expect(iam.mintTokenCalls).toBe(0)
	})

	test('the method selects too: GET of a POST procedure is no endpoint', async () => {
		const { verify } = service({ mintToken: await minted('user') })
		expectDenied(await verify(verifyRequest({ path: '/api/me', cookie: SESSION })), 403)
	})

	test('a trailing slash is a different path', async () => {
		const { verify } = service({ mintToken: await minted('user') })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/me/', cookie: SESSION })), 403)
	})
})

describe('step 3 — a presented key is terminal', () => {
	test('a bearer that is not a px_ key is a 401 with no IAM call', async () => {
		const { iam, verify } = service({})
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/me', bearer: 'eyJhbGciOi.jwt' })), 401)
		expect(iam.mintFromKeyCalls).toBe(0)
	})

	test('an Authorization header that is not a bearer is a 401, never read as absent', async () => {
		const { iam, verify } = service({ mintToken: await minted('user') })
		const response = await verify(
			verifyRequest({ ...JSON_POST, path: '/api/me', cookie: SESSION, headers: { ...JSON_POST.headers, Authorization: 'Basic dTpw' } }),
		)
		expectDenied(response, 401)
		expect(iam.mintTokenCalls).toBe(0)
	})

	test('a key IAM refuses is a 401, and the session beside it is never consulted', async () => {
		const { iam, verify } = service({ mintToken: await minted('user'), mintFromKey: { ok: false, reason: 'invalid_key' } })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/me', bearer: 'px_bad', cookie: SESSION })), 401)
		expect(iam.mintTokenCalls).toBe(0)
	})

	test('a service key on an endpoint only people may call is a 403', async () => {
		const { verify } = service({ mintFromKey: await minted('service', [grant('notes.delete')]) })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/notes.remove', bearer: 'px_machine' })), 403)
	})

	test('a share-link key reaches only a link endpoint', async () => {
		const { verify } = service({ mintFromKey: await minted(undefined) })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/me', bearer: 'px_link' })), 403)
		expect((await verify(verifyRequest({ ...JSON_POST, path: '/s/api/note', bearer: 'px_link' }))).status).toBe(204)
	})

	test('a user key is a human caller, and a cached key is checked for its kind again', async () => {
		const { iam, verify } = service({ mintFromKey: await minted('user', [grant('notes.delete')]) })
		for (let attempt = 0; attempt < 2; attempt++) {
			expect((await verify(verifyRequest({ ...JSON_POST, path: '/api/notes.remove', bearer: 'px_user' }))).status).toBe(204)
			expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/machine/import', bearer: 'px_user' })), 403)
		}
		expect(iam.mintFromKeyCalls).toBe(1)
	})

	test('an unreachable IAM is a 503', async () => {
		const { verify } = service({ unreachable: true })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/me', bearer: 'px_k' })), 503)
	})
})

describe('step 3 — principal kinds', () => {
	test.each(['job', 'webhook'] as const)("a %s key is refused on the application's own machine mount, also from the cache", async (kind) => {
		const { iam, verify } = service({ mintFromKey: await minted(kind, [grant('notes.write'), grant('notes.read')], 'nightly') })
		for (let attempt = 0; attempt < 2; attempt++) {
			for (const path of ['/machine/import', '/api/me', '/__fabrika/connect/products.v1.get']) {
				expectDenied(await verify(verifyRequest({ ...JSON_POST, path, bearer: 'px_workload' })), 403)
			}
		}
		expect(iam.mintFromKeyCalls).toBe(1)
	})

	test('an app:<id> key reaches its export path and nothing else, also from the cache', async () => {
		const { iam, verify } = service({ mintFromKey: await minted('app', [grant('notes.read')], 'shop') })
		for (let attempt = 0; attempt < 2; attempt++) {
			expect((await verify(verifyRequest({ ...JSON_POST, path: '/__fabrika/connect/products.v1.get', bearer: 'px_edge' }))).status).toBe(204)
			for (const path of ['/partner/list', '/api/me', '/machine/import']) {
				expectDenied(await verify(verifyRequest({ ...JSON_POST, path, bearer: 'px_edge' })), 403)
			}
		}
		expect(iam.mintFromKeyCalls).toBe(1)
	})

	test("a service key holding the export's action is refused on the export: only a consumer's app key reaches it", async () => {
		const { verify } = service({ mintFromKey: await minted('service', [grant('notes.read')]) })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/__fabrika/connect/products.v1.get', bearer: 'px_service' })), 403)
	})

	test('the connector key of another application is refused on the export', async () => {
		const { verify } = service({ mintFromKey: await minted('app', [grant('notes.read')], 'crm') })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/__fabrika/connect/products.v1.get', bearer: 'px_crm' })), 403)
	})

	test('a token of an unknown principal kind is refused every time and never cached', async () => {
		const now = Math.floor(Date.now() / 1000)
		const token = await signRawClaims({
			iss: ISSUER,
			aud: 'example-app',
			sub: 'p-1',
			iat: now,
			exp: now + 300,
			perms: [grant('notes.write')],
			label: null,
			ptype: 'robot',
		})
		const { iam, verify } = service({ mintFromKey: { ok: true, token, expiresAt: future() } })
		for (let attempt = 0; attempt < 2; attempt++) {
			expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/machine/import', bearer: 'px_robot' })), 401)
		}
		expect(iam.mintFromKeyCalls).toBe(2)
	})
})

describe('step 4 — no key', () => {
	test('an endpoint people may not call answers 401 to a browser, never a login bounce, and asks IAM nothing', async () => {
		const { iam, verify } = service({ mintToken: await minted('user', [grant('notes.write')]) })
		const response = await verify(verifyRequest({ ...JSON_POST, path: '/machine/import', cookie: SESSION, headers: { 'Sec-Fetch-Mode': 'navigate' } }))
		expectDenied(response, 401)
		expect(response.headers.get('location')).toBeNull()
		expect(iam.mintTokenCalls).toBe(0)
	})

	test('without a session a navigation is bounced to login and a fetch gets the 401 envelope', async () => {
		const { verify } = service({})
		const navigation = await verify(verifyRequest({ path: '/notes' }))
		expect(navigation.status).toBe(302)
		expect(navigation.headers.get('location')).toStartWith(`${ISSUER}/auth/login`)
		const fetched = await verify(verifyRequest({ ...JSON_POST, path: '/api/me', headers: { ...JSON_POST.headers, 'Sec-Fetch-Mode': 'cors' } }))
		expect(fetched.status).toBe(401)
		expect(fetched.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
	})

	test('an IAM that cannot be reached is a 503, never a bounce', async () => {
		const { verify } = service({ unreachable: true })
		expectDenied(await verify(verifyRequest({ path: '/notes', cookie: SESSION })), 503)
	})

	test('a session whose token IAM refuses as too large is a 403', async () => {
		const { verify } = service({ mintToken: { ok: false, reason: 'token_too_large' } })
		expectDenied(await verify(verifyRequest({ path: '/notes', cookie: SESSION })), 403)
	})
})

describe('step 5 — the requirement', () => {
	test('membership needs a permission of the application: authenticated is not authorized', async () => {
		const { verify } = service({ mintToken: await minted('user', []) })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/me', cookie: SESSION })), 403)
	})

	test('an action needs that action in some scope', async () => {
		const { verify } = service({ mintToken: await minted('user', [grant('notes.read'), grant('notes.write', { type: 'note', value: 'n1' })]) })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/notes.remove', cookie: SESSION })), 403)
	})

	test('the action in one scope is enough at the proxy; the framework narrows it to the object', async () => {
		const { verify } = service({ mintToken: await minted('user', [grant('notes.delete', { type: 'note', value: 'n1' })]) })
		expect((await verify(verifyRequest({ ...JSON_POST, path: '/api/notes.remove', cookie: SESSION }))).status).toBe(204)
	})

	test('the app form needs the action held globally: the action in one scope is a 403 at the proxy', async () => {
		const { verify } = service({
			mintToken: await minted('user', [grant('codelists.manage', { type: 'workspace', value: 'w1' }), grant('notes.read')]),
		})
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/codelists.save', cookie: SESSION })), 403)
	})

	test('the app form admits a global grant of the action', async () => {
		const { verify } = service({ mintToken: await minted('user', [grant('codelists.manage')]) })
		expect((await verify(verifyRequest({ ...JSON_POST, path: '/api/codelists.save', cookie: SESSION }))).status).toBe(204)
	})

	test('several capabilities need every action: one of them alone is a 403 at the proxy', async () => {
		const { verify } = service({ mintToken: await minted('user', [grant('requests.handover', { type: 'request', value: 'r1' })]) })
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/requests.handover', cookie: SESSION })), 403)
	})

	test('several capabilities admit a token that carries each action in some scope', async () => {
		const { verify } = service({
			mintToken: await minted('user', [grant('requests.handover', { type: 'request', value: 'r1' }), grant('records.read')]),
		})
		expect((await verify(verifyRequest({ ...JSON_POST, path: '/api/requests.handover', cookie: SESSION }))).status).toBe(204)
	})
})

describe('step 6 — admission', () => {
	test.each<[string, Record<string, string>]>([
		['no Sec-Fetch-Site', { 'Content-Type': 'application/json' }],
		['a cross-site request', { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }],
		['a same-site sibling', { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' }],
	])('a session POST with %s is a 403', async (_name, headers) => {
		const { verify } = service({ mintToken: await minted('user') })
		expectDenied(await verify(verifyRequest({ method: 'POST', path: '/api/me', cookie: SESSION, headers })), 403)
	})

	test('a key request needs no Sec-Fetch-Site: no browser sends a key', async () => {
		const { verify } = service({ mintFromKey: await minted('service') })
		expect((await verify(verifyRequest({ method: 'POST', path: '/api/me', bearer: 'px_k', headers: { 'Content-Type': 'application/json' } }))).status)
			.toBe(204)
	})

	test.each([undefined, 'text/plain', 'application/jsonx'])('an RPC request with Content-Type %p is a 400', async (contentType) => {
		const { verify } = service({ mintFromKey: await minted('service') })
		const headers: Record<string, string> = contentType === undefined ? {} : { 'Content-Type': contentType }
		expectDenied(await verify(verifyRequest({ method: 'POST', path: '/api/me', bearer: 'px_k', headers })), 400)
	})

	test('a parameter on the media type is admitted', async () => {
		const { verify } = service({ mintFromKey: await minted('service') })
		const headers = { 'Content-Type': 'Application/JSON; charset=utf-8' }
		expect((await verify(verifyRequest({ method: 'POST', path: '/api/me', bearer: 'px_k', headers }))).status).toBe(204)
	})
})

describe('anonymous kinds', () => {
	test('health reads no credential, mints no token and asks IAM nothing, even when a key and a session arrive', async () => {
		const { iam, verify } = service({ mintToken: await minted('user'), mintFromKey: await minted('service') })
		const response = await verify(verifyRequest({ path: '/healthz', bearer: 'px_k', cookie: SESSION }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
		expect(response.headers.get(ENDPOINT_HEADER)).toBe(formatEndpointHeader(HEALTH.id, HEALTH.digest))
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls + iam.jwksCalls).toBe(0)
	})

	test('a public SPA reads no credential and never bounces; the member SPA under it still does', async () => {
		const site = anonymousRow({ id: 'site', kind: 'public-spa', method: 'GET', path: '/*', admission: null })
		const app = endpointRow({
			id: 'web',
			kind: 'spa',
			method: 'GET',
			path: '/app/*',
			callers: ['human'],
			requirement: { kind: 'member' },
			admission: null,
		})
		const iam = new FakeIam({ mintToken: await minted('user'), mintFromKey: await minted('service') })
		const verify = createVerifyService({ manifest: { apps: [contractAppWith([site, app, ME], ['/api'])] }, iam, issuer: ISSUER })

		for (const path of ['/', '/assets/app.js']) {
			const anonymous = await verify(verifyRequest({ path, headers: { 'Sec-Fetch-Mode': 'navigate' } }))
			expect(anonymous.status).toBe(204)
			expect(anonymous.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
			expect(anonymous.headers.get(ENDPOINT_HEADER)).toBe(formatEndpointHeader(site.id, site.digest))
		}
		const credentialed = await verify(verifyRequest({ path: '/', bearer: 'px_k', cookie: SESSION }))
		expect(credentialed.status).toBe(204)
		expect(credentialed.headers.get(PROXY_TOKEN_HEADER)).toBeNull()
		expect(iam.mintTokenCalls + iam.mintFromKeyCalls + iam.jwksCalls).toBe(0)

		expectDenied(await verify(verifyRequest({ method: 'POST', path: '/', headers: { 'Content-Type': 'application/json' } })), 403)
		const member = await verify(verifyRequest({ path: '/app/', headers: { 'Sec-Fetch-Mode': 'navigate' } }))
		expect(member.status).toBe(302)
		expect(member.headers.get('location')).toStartWith(`${ISSUER}/auth/login`)
		expectDenied(await verify(verifyRequest({ ...JSON_POST, path: '/api/me', headers: { ...JSON_POST.headers, 'Sec-Fetch-Mode': 'cors' } })), 401)
	})

	test('a form admits only its content type', async () => {
		const { verify } = service({})
		expectDenied(await verify(verifyRequest({ method: 'POST', path: '/contact', headers: { 'Content-Type': 'application/json' } })), 400)
		const admitted = await verify(verifyRequest({ method: 'POST', path: '/contact', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }))
		expect(admitted.status).toBe(204)
	})
})

describe('allow', () => {
	test('carries the token and the selected endpoint with the digest of the rules applied', async () => {
		const { verify } = service({ mintToken: await minted('user') })
		const response = await verify(verifyRequest({ ...JSON_POST, path: '/api/me', cookie: SESSION }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).not.toBeNull()
		expect(response.headers.get(ENDPOINT_HEADER)).toBe(`api.me@${ME.digest}`)
		expect(response.headers.get(DELEGATION_HEADER)).toBeNull()
	})

	test('the most specific endpoint wins: the SPA serves only what no procedure does', async () => {
		const { verify } = service({ mintToken: await minted('user') })
		const response = await verify(verifyRequest({ path: '/notes/n1' }))
		expect(response.status).toBe(302)
		const spa = await verify(verifyRequest({ path: '/notes/n1', cookie: SESSION }))
		expect(spa.headers.get(ENDPOINT_HEADER)).toBe(`web@${SPA.digest}`)
	})
})

describe('delegation grants', () => {
	test('a membership endpoint gets a fresh grant for every request, also with a warm token cache', async () => {
		const delegations = new FakeDelegations('grant')
		const { iam, verify } = service({ mintToken: await minted('user', [grant('notes.admin', { type: 'workspace', value: 'w1' })]) }, delegations)
		const first = await verify(verifyRequest({ ...JSON_POST, path: '/api/workspaces.invite', cookie: SESSION }))
		const second = await verify(verifyRequest({ ...JSON_POST, path: '/api/workspaces.invite', cookie: SESSION }))
		expect([first.status, second.status]).toEqual([204, 204])
		expect([first.headers.get(DELEGATION_HEADER), second.headers.get(DELEGATION_HEADER)]).toEqual(['grant-1', 'grant-2'])
		expect(iam.mintTokenCalls).toBe(1)
		expect(delegations.seen.map((input) => input.endpoint)).toEqual([INVITE.id, INVITE.id])
		expect(delegations.seen[0]?.credential).toBe(first.headers.get(PROXY_TOKEN_HEADER) ?? '')
		expect(new Set(delegations.seen.map((input) => input.requestId)).size).toBe(2)
	})

	test('no other endpoint asks for one', async () => {
		const delegations = new FakeDelegations('grant')
		const { verify } = service({ mintToken: await minted('user') }, delegations)
		expect((await verify(verifyRequest({ ...JSON_POST, path: '/api/me', cookie: SESSION }))).status).toBe(204)
		expect(delegations.seen).toEqual([])
	})

	test('a request refused before the grant spends none', async () => {
		const delegations = new FakeDelegations('grant')
		const { verify } = service({ mintToken: await minted('user', [grant('notes.admin')]) }, delegations)
		expectDenied(await verify(verifyRequest({ method: 'POST', path: '/api/workspaces.invite', cookie: SESSION })), 403)
		expect(delegations.seen).toEqual([])
	})

	test('a grant IAM refuses is a 403, an IAM it cannot reach a 503', async () => {
		const token = await minted('user', [grant('notes.admin')])
		expectDenied(
			await service({ mintToken: token }, new FakeDelegations('refuse')).verify(
				verifyRequest({ ...JSON_POST, path: '/api/workspaces.invite', cookie: SESSION }),
			),
			403,
		)
		expectDenied(
			await service({ mintToken: token }, new FakeDelegations('throw')).verify(
				verifyRequest({ ...JSON_POST, path: '/api/workspaces.invite', cookie: SESSION }),
			),
			503,
		)
	})

	test('without an issuer the request carries no grant, and IAM refuses the membership operation itself', async () => {
		const { verify } = service({ mintToken: await minted('user', [grant('notes.admin')]) })
		const response = await verify(verifyRequest({ ...JSON_POST, path: '/api/workspaces.invite', cookie: SESSION }))
		expect(response.status).toBe(204)
		expect(response.headers.get(DELEGATION_HEADER)).toBeNull()
	})
})
