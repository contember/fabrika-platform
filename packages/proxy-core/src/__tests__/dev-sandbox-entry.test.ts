/**
 * The decision for a dev sandbox entry (`dev:<app>:<workspace>`): IAM and the token verifier see the entry's audience
 * (`<app>@<env>`), while the route, the `?app=` pin and the host check stay on the entry id.
 */

import { AUTH_CALLBACK_PATH, type ExchangeAuthCodeResult, HANDOFF_COOKIE_PREFIX, type MintTokenResult, SESSION_COOKIE } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { MemoryTokenCache } from '../cache'
import { AUTH_SIGNOUT_PATH, PROXY_TOKEN_HEADER } from '../constants'
import type { DelegationIssuer, DelegationRequest } from '../iam'
import { type ContractProxyApp, parseProxyManifest, type ProxyManifest } from '../manifest'
import { createVerifyService, type VerifyService } from '../service'
import { anonymousRow, contractAppWith, endpointRow, FakeIam, type FakeIamOptions, ISSUER, signToken, verifyRequest } from './helpers'

const AUDIENCE = 'notes@dev'
const WORKSPACE_A = '01934f6e-7b1a-7c3d-8e4f-0123456789ab'
const WORKSPACE_B = '01934f6e-7b1a-7c3d-8e4f-ba9876543210'
const ENTRY_A = `dev:notes:${WORKSPACE_A}`
const ENTRY_B = `dev:notes:${WORKSPACE_B}`
const HOST_A = `${WORKSPACE_A}.dev.example.com`
const HOST_B = `${WORKSPACE_B}.dev.example.com`
const SESSION = `${SESSION_COOKIE}=s`
const STATE = 'state-state-state1'

const SPA = endpointRow({
	id: 'web',
	kind: 'spa',
	method: 'GET',
	path: '/*',
	callers: ['human', 'machine'],
	requirement: { kind: 'member' },
	admission: null,
})
const INVITE = endpointRow({
	id: 'api.workspaces.invite',
	kind: 'mutation',
	method: 'POST',
	path: '/api/workspaces.invite',
	callers: ['human'],
	requirement: { kind: 'member' },
	admission: { contentTypes: ['application/json'], maxBytes: 65_536 },
}, 'members')
const HEALTH = anonymousRow({ id: 'health', kind: 'health', method: 'GET', path: '/healthz', admission: null })

function sandbox(id: string, host: string, upstreamHost: string, endpoints = [SPA, INVITE, HEALTH]): ContractProxyApp {
	return contractAppWith(endpoints, ['/api'], { id, hosts: [host], audience: AUDIENCE, upstream: 'zbox:8081', upstreamHost })
}

/** Two workspaces of one application: one audience, two hosts. B serves only its health row, so a request that reaches B is visible. */
function manifest(): ProxyManifest {
	const parsed = parseProxyManifest({
		apps: [sandbox(ENTRY_A, HOST_A, '3000-sbxa.box.example.com'), sandbox(ENTRY_B, HOST_B, '3000-sbxb.box.example.com', [HEALTH])],
	})
	if (parsed === null) throw new Error('the dev sandbox manifest must parse')
	return parsed
}

/** Records the app each code exchange names, which `FakeIam` does not. */
class RecordingIam extends FakeIam {
	readonly exchangeApps: string[] = []

	override exchangeAuthCode(input: { app: string; code: string; verifier: string }): Promise<ExchangeAuthCodeResult> {
		this.exchangeApps.push(input.app)
		return super.exchangeAuthCode(input)
	}
}

class RecordingDelegations implements DelegationIssuer {
	readonly seen: DelegationRequest[] = []

	requestDelegation(input: DelegationRequest): ReturnType<DelegationIssuer['requestDelegation']> {
		this.seen.push(input)
		return Promise.resolve({ ok: true, grant: 'grant-1', expiresAt: future() })
	}
}

const future = (seconds = 300) => Math.floor(Date.now() / 1000) + seconds

async function mintedFor(audience: string): Promise<MintTokenResult> {
	return { ok: true, token: await signToken({ type: 'user', audience }), expiresAt: future() }
}

function service(options: FakeIamOptions, delegations: DelegationIssuer | null = null): { iam: RecordingIam; verify: VerifyService } {
	const iam = new RecordingIam(options)
	const verify = createVerifyService({ manifest: manifest(), iam, issuer: ISSUER, cache: new MemoryTokenCache(), delegations })
	return { iam, verify }
}

describe('a dev sandbox entry mints and verifies for its audience', () => {
	test('a session mints for the audience, and a token for the audience is admitted', async () => {
		const { iam, verify } = service({ mintToken: await mintedFor(AUDIENCE) })
		const response = await verify(verifyRequest({ host: HOST_A, app: ENTRY_A, cookie: SESSION }))
		expect(response.status).toBe(204)
		expect(response.headers.get(PROXY_TOKEN_HEADER)).not.toBeNull()
		expect(iam.seenApps).toEqual([AUDIENCE])

		// The warm path verifies the cached token against the audience too: no second mint.
		expect((await verify(verifyRequest({ host: HOST_A, app: ENTRY_A, cookie: SESSION }))).status).toBe(204)
		expect(iam.mintTokenCalls).toBe(1)
	})

	test('a token minted for the entry id is no token for the sandbox', async () => {
		const { verify } = service({ mintToken: await mintedFor(ENTRY_A) })
		const response = await verify(verifyRequest({ host: HOST_A, app: ENTRY_A, cookie: SESSION }))
		expect(response.status).toBe(302)
		expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/auth/login')
	})

	test('a key mints for the audience', async () => {
		const { iam, verify } = service({ mintFromKey: { ok: true, token: await signToken({ type: 'service', audience: AUDIENCE }), expiresAt: future() } })
		const response = await verify(verifyRequest({ host: HOST_A, app: ENTRY_A, bearer: 'px_key' }))
		expect(response.status).toBe(204)
		expect(iam.seenApps).toEqual([AUDIENCE])
	})

	test('the login bounce names the audience and returns to the sandbox host', async () => {
		const { verify } = service({})
		const response = await verify(verifyRequest({ host: HOST_A, app: ENTRY_A, path: '/notes' }))
		expect(response.status).toBe(302)
		const location = new URL(response.headers.get('location') ?? '')
		expect(location.searchParams.get('app')).toBe(AUDIENCE)
		expect(location.searchParams.get('redirect')).toBe(`https://${HOST_A}/notes`)
	})

	test('the handoff callback redeems the code for the audience', async () => {
		const { iam, verify } = service({
			exchangeAuthCode: { ok: true, session: 'app-session', returnUrl: `https://${HOST_A}/`, expiresAt: future(3600) },
		})
		const response = await verify(verifyRequest({
			host: HOST_A,
			app: ENTRY_A,
			path: `${AUTH_CALLBACK_PATH}?code=c&state=${STATE}`,
			cookie: `${HANDOFF_COOKIE_PREFIX}${STATE}=verifier`,
		}))
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe(`https://${HOST_A}/`)
		expect(response.headers.getSetCookie().some((value) => value.startsWith(`${SESSION_COOKIE}=app-session;`))).toBe(true)
		expect(iam.exchangeApps).toEqual([AUDIENCE])
	})

	test('the sign-out releases the audience at IAM', async () => {
		const { verify } = service({})
		const response = await verify(verifyRequest({
			host: HOST_A,
			app: ENTRY_A,
			path: `${AUTH_SIGNOUT_PATH}?redirect=%2F`,
			cookie: SESSION,
			headers: { 'Sec-Fetch-Site': 'same-origin' },
		}))
		expect(response.status).toBe(302)
		expect(new URL(response.headers.get('location') ?? '').searchParams.get('app')).toBe(AUDIENCE)
	})

	test('a delegation grant is asked for the audience', async () => {
		const delegations = new RecordingDelegations()
		const { verify } = service({ mintToken: await mintedFor(AUDIENCE) }, delegations)
		const response = await verify(verifyRequest({
			host: HOST_A,
			app: ENTRY_A,
			path: INVITE.path,
			method: 'POST',
			cookie: SESSION,
			headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
		}))
		expect(response.status).toBe(204)
		expect(delegations.seen.map((input) => input.app)).toEqual([AUDIENCE])
	})
})

describe('two sandboxes of one application stay apart', () => {
	test('each host resolves to its own entry, by pin and by host', async () => {
		const { verify } = service({ mintToken: await mintedFor(AUDIENCE) })
		expect((await verify(verifyRequest({ host: HOST_A, app: ENTRY_A, cookie: SESSION }))).status).toBe(204)
		expect((await verify(verifyRequest({ host: HOST_A, app: null, cookie: SESSION }))).status).toBe(204)
		// B's table has no page row: reaching it is a 403 no_endpoint, not A's allow.
		expect((await verify(verifyRequest({ host: HOST_B, app: ENTRY_B, cookie: SESSION }))).status).toBe(403)
		expect((await verify(verifyRequest({ host: HOST_B, app: null, cookie: SESSION }))).status).toBe(403)
	})

	test("a code that returns to one sandbox's host is refused at the other's callback, and clears the handoff state", async () => {
		const { iam, verify } = service({
			exchangeAuthCode: { ok: true, session: 'app-session', returnUrl: `https://${HOST_A}/notes`, expiresAt: future(3600) },
		})
		const response = await verify(verifyRequest({
			host: HOST_B,
			app: ENTRY_B,
			path: `${AUTH_CALLBACK_PATH}?code=c&state=${STATE}`,
			cookie: `${HANDOFF_COOKIE_PREFIX}${STATE}=verifier`,
		}))
		expect(response.status).toBe(403)
		expect(response.headers.get('location')).toBeNull()
		const cookies = response.headers.getSetCookie()
		expect(cookies.some((value) => value.startsWith(`${SESSION_COOKIE}=`))).toBe(false)
		expect(cookies.find((value) => value.startsWith(`${HANDOFF_COOKIE_PREFIX}${STATE}=`))?.split('; ')).toContain('Max-Age=0')
		expect(iam.exchangeApps).toEqual([AUDIENCE])
	})

	test("a request to one sandbox's host pinned to the other's entry is refused before IAM", async () => {
		const { iam, verify } = service({ mintToken: await mintedFor(AUDIENCE) })
		expect((await verify(verifyRequest({ host: HOST_A, app: ENTRY_B, cookie: SESSION }))).status).toBe(403)
		expect((await verify(verifyRequest({ host: HOST_B, app: ENTRY_A, cookie: SESSION }))).status).toBe(403)
		// The audience is no entry id: it pins nothing.
		expect((await verify(verifyRequest({ host: HOST_A, app: AUDIENCE, cookie: SESSION }))).status).toBe(403)
		expect(iam.mintTokenCalls).toBe(0)
	})
})
