/**
 * `audit` records the app the caller's verified token was minted for. The event carries no `app`, and
 * one named in an HTTP body is not read: a binding or `rpcKey` holder cannot file an event under an
 * app whose token it does not hold.
 */

import { type AuditInput, buildAccessClaims, buildResourceAccessClaims } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair } from 'jose'
import { AUDIT_TOKEN_EXPIRY_GRACE_SECONDS } from '../auth'
import type { Env, RequestContext } from '../env'
import { createIamRpc } from '../rpc'
import { handleRpcHttp } from '../rpc-http'
import { getSigner, Signer } from '../signing'
import { createHarness, type Harness, TEST_SIGNING_ENV, TEST_SIGNING_KEYS } from './helpers/harness'

const ISSUER = 'https://iam.example.test'
const RPC_KEY = 'rpc-test-key-0123456789abcdefghij'

class TestContext implements RequestContext {
	readonly pending: Promise<unknown>[] = []
	readonly waitUntil = (promise: Promise<unknown>): void => {
		this.pending.push(promise)
	}
	async drain(): Promise<void> {
		await Promise.all(this.pending)
	}
}

function env(h: Harness): Env {
	return {
		DB: unusedDatabase,
		REPOSITORIES: h.repositories,
		HUMAN_EMAIL_DOMAINS: '[]',
		HUMAN_EMAILS: '[]',
		IAM_BOOTSTRAP_ADMINS: '[]',
		ENVIRONMENT: 'stage',
		OIDC_ENABLED: 'false',
		PASSWORD_ENABLED: 'true',
		EMAIL_PROVIDER: 'none',
		ISSUER,
		FABRIKA_IAM_SIGNING_KEYS: TEST_SIGNING_KEYS,
		FABRIKA_IAM_PROVISIONING_KEY: '',
	}
}

const now = Math.floor(Date.now() / 1000)
const signer = await getSigner(TEST_SIGNING_ENV)

const { privateKey: strangerKey } = await generateKeyPair('ES256', { extractable: true })
/** A well-formed signer whose keys IAM never published. */
const stranger = await Signer.fromPrivateJwks([await exportJWK(strangerKey)])

interface TokenOptions {
	iss?: string
	expiresAt?: number
	by?: Signer
}

function appToken(app: string, options: TokenOptions = {}): Promise<string> {
	const expiresAt = options.expiresAt ?? now + 300
	return (options.by ?? signer).sign(buildAccessClaims({
		iss: options.iss ?? ISSUER,
		app,
		subject: 'cred-1',
		label: 'share link',
		permissions: [],
		issuedAt: expiresAt - 300,
		expiresAt,
	}))
}

function resourceToken(app: string, options: TokenOptions = {}): Promise<string> {
	const expiresAt = options.expiresAt ?? now + 300
	return (options.by ?? signer).signResourceToken(buildResourceAccessClaims({
		iss: options.iss ?? ISSUER,
		app,
		resource: 'https://control.example.test/mcp',
		subject: 'user-1',
		label: 'a@b.cz',
		permissions: [],
		issuedAt: expiresAt - 300,
		expiresAt,
		clientId: 'https://client.test/metadata.json',
		scopes: ['authoring'],
		grantId: 'grant-1',
		tokenId: 'token-1',
	}))
}

const KINDS: [string, (app: string, options?: TokenOptions) => Promise<string>][] = [
	['a native token', appToken],
	['an OAuth resource token', resourceToken],
]
const JUST_INSIDE = now - AUDIT_TOKEN_EXPIRY_GRACE_SECONDS + 60
const JUST_OUTSIDE = now - AUDIT_TOKEN_EXPIRY_GRACE_SECONDS - 60

function event(credential: string): AuditInput {
	return { credential, requestId: 'req-1', principalId: null, principalLabel: 'share link', action: 'report.view', resourceType: 'report' }
}

function auditedApps(h: Harness): string[] {
	return h.sqlite.query<{ app: string }, []>('SELECT app FROM audit_events').all().map((row) => row.app)
}

async function auditOverBinding(credential: string): Promise<string[]> {
	const h = createHarness()
	const ctx = new TestContext()
	await createIamRpc(env(h), ctx).audit(event(credential))
	await ctx.drain()
	return auditedApps(h)
}

function rpcRequest(body: unknown): Request {
	return new Request(`${ISSUER}/rpc/audit`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', Authorization: `Bearer ${RPC_KEY}` },
		body: JSON.stringify(body),
	})
}

describe('audit takes the app from the verified caller', () => {
	test('records the app the token was minted for', async () => {
		expect(await auditOverBinding(await appToken('reports'))).toEqual(['reports'])
	})

	test('an app named in the HTTP body is ignored: the row is filed under the token app', async () => {
		const h = createHarness()
		const ctx = new TestContext()
		const forged = { ...event(await appToken('reports')), app: 'billing' }

		const response = await handleRpcHttp(rpcRequest(forged), createIamRpc(env(h), ctx), RPC_KEY)
		await ctx.drain()

		expect(response.status).toBe(204)
		expect(auditedApps(h)).toEqual(['reports'])
	})

	test('an HTTP body without a credential is refused as malformed', async () => {
		const h = createHarness()
		const { credential: _credential, ...withoutCredential } = event('unused')
		const response = await handleRpcHttp(rpcRequest({ ...withoutCredential, app: 'billing' }), createIamRpc(env(h), new TestContext()), RPC_KEY)

		expect(response.status).toBe(400)
		const body: unknown = await response.json()
		expect(body).toEqual({ error: "invalid or missing field 'credential'" })
		expect(auditedApps(h)).toEqual([])
	})

	test.each([
		['a value that is not a token', () => Promise.resolve('not.a.jwt')],
		['a native token from another issuer', () => appToken('reports', { iss: 'https://elsewhere.test' })],
		['a resource token from another issuer', () => resourceToken('reports', { iss: 'https://elsewhere.test' })],
		['a native token signed by an unpublished key', () => appToken('reports', { by: stranger })],
		['a resource token signed by an unpublished key', () => resourceToken('reports', { by: stranger })],
	])('%s writes no row and does not throw', async (_name, credential) => {
		expect(await auditOverBinding(await credential())).toEqual([])
	})

	test('an OAuth resource token records its signed app, not the resource it names', async () => {
		expect(await auditOverBinding(await resourceToken('vozka'))).toEqual(['vozka'])
	})
})

describe('a request that outlives its token still audits, within the grace', () => {
	test.each(KINDS)('%s expired just inside the grace is recorded', async (_kind, token) => {
		expect(await auditOverBinding(await token('reports', { expiresAt: JUST_INSIDE }))).toEqual(['reports'])
	})

	test.each(KINDS)('%s expired just outside the grace writes no row', async (_kind, token) => {
		expect(await auditOverBinding(await token('reports', { expiresAt: JUST_OUTSIDE }))).toEqual([])
	})

	test('the grace is not authorization: a management call refuses the same expired token', async () => {
		const h = createHarness()
		const credential = await appToken('reports', { expiresAt: now - 60 })
		const result = await createIamRpc(env(h), new TestContext()).listPrincipals({ app: 'reports', credential, requestId: 'req-1' })
		expect(result).toEqual({ ok: false, reason: 'invalid_token' })
	})
})
