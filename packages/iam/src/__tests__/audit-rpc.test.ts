/**
 * `audit` records the app the caller's verified token was minted for. The event carries no `app`, and
 * one named in an HTTP body is not read: a binding or `rpcKey` holder cannot file an event under an
 * app whose token it does not hold.
 */

import { type AuditInput, buildAccessClaims, buildResourceAccessClaims } from '@fabrika/auth-core'
import { unusedDatabase } from '@fabrika/platform/testing'
import { describe, expect, test } from 'bun:test'
import type { Env, RequestContext } from '../env'
import { createIamRpc } from '../rpc'
import { handleRpcHttp } from '../rpc-http'
import { getSigner } from '../signing'
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

function appToken(app: string, options: { iss?: string; expiresAt?: number } = {}): Promise<string> {
	return signer.sign(buildAccessClaims({
		iss: options.iss ?? ISSUER,
		app,
		subject: 'cred-1',
		label: 'share link',
		permissions: [],
		issuedAt: now - 600,
		expiresAt: options.expiresAt ?? now + 300,
	}))
}

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
		['a token from another issuer', () => appToken('reports', { iss: 'https://elsewhere.test' })],
		['an expired token', () => appToken('reports', { expiresAt: now - 60 })],
	])('%s writes no row and does not throw', async (_name, credential) => {
		expect(await auditOverBinding(await credential())).toEqual([])
	})

	test('an OAuth resource token records its signed app, not the resource it names', async () => {
		const claims = buildResourceAccessClaims({
			iss: ISSUER,
			app: 'vozka',
			resource: 'https://control.example.test/mcp',
			subject: 'user-1',
			label: 'a@b.cz',
			permissions: [],
			issuedAt: now - 60,
			expiresAt: now + 300,
			clientId: 'https://client.test/metadata.json',
			scopes: ['authoring'],
			grantId: 'grant-1',
			tokenId: 'token-1',
		})
		expect(await auditOverBinding(await signer.signResourceToken(claims))).toEqual(['vozka'])
	})
})
