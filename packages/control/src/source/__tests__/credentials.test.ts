import { describe, expect, test } from 'bun:test'
import { createHarness, type Harness } from '../../__tests__/helpers/harness'
import type { Env } from '../../env'
import { githubAppCredentialSecretLabel } from '../../github-connection-store'
import { Vault } from '../../vault'
import { decodeGitHubAppCredential, encodeGitHubAppCredential, gitHubAppClientFactory, vaultGitHubCredentials } from '../credentials'

function testKey(): string {
	let binary = ''
	for (let index = 0; index < 32; index++) binary += String.fromCharCode(index + 1)
	return btoa(binary)
}

interface TestApp {
	readonly appId: string
	readonly privateKeyPem: string
	readonly publicKey: CryptoKey
}

async function generateApp(appId: string): Promise<TestApp> {
	const pair = await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify'],
	)
	const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
	const body = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n')
	return { appId, privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey }
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
	const bytes = new Uint8Array(new ArrayBuffer(binary.length))
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
	return bytes
}

interface Mint {
	readonly issuer: string
	readonly installationId: number
	readonly repositories: unknown
}

/** A GitHub double that accepts a token request only when its JWT verifies against the issuing App's own key. */
function githubDouble(apps: readonly TestApp[], installations: ReadonlyMap<number, string>) {
	const mints: Mint[] = []
	let requests = 0
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		requests++
		const url = new URL(input instanceof Request ? input.url : String(input))
		const match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname)
		if (url.origin !== 'https://api.github.com' || match === null || init?.method !== 'POST') return new Response(null, { status: 404 })
		const jwt = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '') ?? ''
		const [header, payload, signature] = jwt.split('.')
		if (header === undefined || payload === undefined || signature === undefined) return new Response(null, { status: 401 })
		const claims: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)))
		const issuer = typeof claims === 'object' && claims !== null && 'iss' in claims && typeof claims.iss === 'string' ? claims.iss : ''
		const app = apps.find((candidate) => candidate.appId === issuer)
		const signed = new TextEncoder().encode(`${header}.${payload}`)
		if (app === undefined || !await crypto.subtle.verify('RSASSA-PKCS1-v1_5', app.publicKey, decodeBase64Url(signature), signed)) {
			return new Response(null, { status: 401 })
		}
		const installationId = Number(match[1])
		if (installations.get(installationId) !== issuer) return new Response(null, { status: 404 })
		const body: unknown = JSON.parse(String(init.body))
		mints.push({ issuer, installationId, repositories: typeof body === 'object' && body !== null && 'repositories' in body ? body.repositories : null })
		return Response.json({ token: `ghs_${issuer}_${installationId}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
	}
	return { fetch, mints, requests: () => requests }
}

function environment(harness: Harness): Env {
	return {
		DB: harness.d1,
		REPOSITORIES: harness.repositories,
		ASSETS: { fetch: () => Promise.resolve(new Response()) },
		RUN_LOGS: { put: () => Promise.resolve(), get: () => Promise.resolve(null), delete: () => Promise.resolve() },
		DEPLOY_QUEUE: { send: () => Promise.resolve() },
		WAIT_UNTIL: () => {},
		REPO_EVENTS: { verifyWebhook: () => Promise.resolve(null), resolveInstallationId: () => Promise.resolve(null) },
		ENVIRONMENT: 'test',
		FABRIKA_CONTROL_VAULT_KEY: testKey(),
	}
}

async function connect(harness: Harness, vault: Vault, input: { connectionId: string; owner: string; installationId: number; app: TestApp }) {
	const credentialRef = await vault.putSecret(
		'platform',
		githubAppCredentialSecretLabel(input.connectionId),
		encodeGitHubAppCredential({ appId: input.app.appId, privateKeyPem: input.app.privateKeyPem }),
	)
	harness.sqlite.query(`INSERT INTO github_source_connections_keyed (
		connection_id, app_id, app_slug, app_html_url, app_owner, app_name, app_public,
		app_credential_ref, webhook_url, webhook_secret_ref, installation_id,
		installation_account_login, installation_selection, verified_repositories_json,
		requested_repositories_json, connected_by, connected_at, verified_at, version
	) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'all', '[]', '[]', 'test', 1, 1, 1)`).run(
		input.connectionId,
		input.app.appId,
		`${input.connectionId}-app`,
		`https://github.com/apps/${input.connectionId}-app`,
		input.owner,
		`${input.connectionId}-app`,
		credentialRef,
		`https://control.test/webhooks/github/${input.connectionId}`,
		`vault:${input.connectionId}-webhook`,
		input.installationId,
		input.owner,
	)
	return credentialRef
}

/** Two organizations, each with its own private App and key in the vault (ADR-0029). */
async function twoConnections() {
	const harness = createHarness()
	const env = environment(harness)
	const vault = await Vault.create(harness.d1, testKey())
	const alpha = await generateApp('1001')
	const beta = await generateApp('2002')
	const alphaRef = await connect(harness, vault, { connectionId: 'alpha', owner: 'acme', installationId: 11, app: alpha })
	await connect(harness, vault, { connectionId: 'beta', owner: 'beta-org', installationId: 22, app: beta })
	const github = githubDouble([alpha, beta], new Map([[11, alpha.appId], [22, beta.appId]]))
	const credentials = vaultGitHubCredentials(env, { createClient: gitHubAppClientFactory(github.fetch) })
	return { harness, vault, alpha, beta, alphaRef, github, credentials }
}

const signal = (): AbortSignal => new AbortController().signal

describe('vault-held keyed GitHub credentials', () => {
	test('each connection mints its repository token with its own App key', async () => {
		const f = await twoConnections()
		const [alphaToken, betaToken] = await Promise.all([
			f.credentials.repositoryToken({ connectionId: 'alpha', installationId: 11, repository: { owner: 'acme', name: 'app' }, signal: signal() }),
			f.credentials.repositoryToken({ connectionId: 'beta', installationId: 22, repository: { owner: 'Beta-Org', name: 'site' }, signal: signal() }),
		])
		expect(alphaToken).toBe('ghs_1001_11')
		expect(betaToken).toBe('ghs_2002_22')
		expect([...f.github.mints].sort((left, right) => left.installationId - right.installationId)).toEqual([
			{ issuer: '1001', installationId: 11, repositories: ['app'] },
			{ issuer: '2002', installationId: 22, repositories: ['site'] },
		])
	})

	test.each([
		{
			name: 'an installation of the other connection',
			request: { connectionId: 'alpha', installationId: 22, repository: { owner: 'acme', name: 'app' } },
		},
		{ name: 'an unknown connection', request: { connectionId: 'gamma', installationId: 11, repository: { owner: 'acme', name: 'app' } } },
		{ name: 'a repository of another owner', request: { connectionId: 'alpha', installationId: 11, repository: { owner: 'beta-org', name: 'site' } } },
	])('fails closed on $name without trying another App', async ({ request }) => {
		const f = await twoConnections()
		await expect(f.credentials.repositoryToken({ ...request, signal: signal() })).rejects.toMatchObject({
			code: 'installation_not_found',
			stage: 'credentials',
		})
		expect(f.github.requests()).toBe(0)
	})

	test('refuses a key stored under another purpose', async () => {
		const f = await twoConnections()
		f.harness.sqlite.query(`UPDATE vault SET label = ? WHERE id = ?`).run(githubAppCredentialSecretLabel('beta'), f.alphaRef.slice('vault:'.length))
		await expect(
			f.credentials.repositoryToken({ connectionId: 'alpha', installationId: 11, repository: { owner: 'acme', name: 'app' }, signal: signal() }),
		)
			.rejects.toMatchObject({ code: 'credentials_invalid' })
		expect(f.github.requests()).toBe(0)
	})

	test('the stored credential has one canonical spelling and refuses anything else without echoing it', () => {
		const encoded = encodeGitHubAppCredential({ appId: '1001', privateKeyPem: 'pem-material' })
		expect(encoded).toBe('{"appId":"1001","privateKeyPem":"pem-material"}')
		expect(decodeGitHubAppCredential(encoded)).toEqual({ appId: '1001', privateKeyPem: 'pem-material' })
		for (
			const value of [
				'{"appId":"1001","privateKeyPem":"pem-material","extra":1}',
				'{"appId":"0","privateKeyPem":"pem-material"}',
				'pem-material',
				`"${'x'.repeat(80 * 1024)}"`,
			]
		) {
			expect(() => decodeGitHubAppCredential(value)).toThrow('GitHub App credential is invalid')
		}
	})
})
