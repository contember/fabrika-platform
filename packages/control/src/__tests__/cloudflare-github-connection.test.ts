import { type AuthContext, PROXY_TOKEN_HEADER } from '@fabrika/auth'
import { cloudflareArtifact, cloudflareArtifactCodec, cloudflareStoredTargetCodec } from '@fabrika/provider-cloudflare'
import type { ProviderEnvelope } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { controlApp } from '../app'
import type { Env } from '../env'
import { cloudflareControlProvider, cloudflareGitHubSource, type CloudflareSourceSeams, controlEnv, type WorkerBindings } from '../platform-cf'
import type { ControlJobMessage } from '../run-lifecycle'
import { vault } from '../services'
import { manifestCallback, startSourceConnection, verifySourceInstallation } from '../source-connection'
import { createSourceConnections } from '../source/connections'
import { gitHubAppClientFactory } from '../source/credentials'
import { createHarness, type Harness, pushWebhookRequest } from './helpers/harness'
import { adminToken, testIamEnv } from './helpers/tokens'

// The Cloudflare composition over the D1 schema (SQLite): connect a GitHub App from the console
// workflow, bind an app to it, receive its scoped webhook, and mint a repository token from the vault.

const ORIGIN = 'https://control.test'
const APP_ID = 123
const INSTALLATION_ID = 456
const COMMIT = 'c'.repeat(40)

function vaultKey(): string {
	let binary = ''
	for (let index = 0; index < 32; index++) binary += String.fromCharCode(index + 1)
	return btoa(binary)
}

async function appPrivateKeyPem(): Promise<string> {
	const pair = await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify'],
	)
	const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
	const body = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n')
	return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}

function jwtIssuer(authorization: string | null): string | null {
	const payload = authorization?.replace(/^Bearer /, '').split('.')[1]
	if (payload === undefined) return null
	const claims: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
	return typeof claims === 'object' && claims !== null && 'iss' in claims && typeof claims.iss === 'string' ? claims.iss : null
}

/** GitHub's App API for one private App installed on `acme`; it answers only an App JWT issued by that App. */
function githubAppDouble() {
	const webhook = { url: '', secret: '' }
	const mints: Array<{ installationId: number; body: unknown }> = []
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input))
		// The App is private: its public page is a miss for an anonymous reader.
		if (url.origin !== 'https://api.github.com' || url.pathname.startsWith('/apps/')) return new Response(null, { status: 404 })
		if (jwtIssuer(new Headers(init?.headers).get('authorization')) !== String(APP_ID)) return new Response(null, { status: 401 })
		const method = init?.method ?? 'GET'
		if (method === 'GET' && url.pathname === '/app') {
			return Response.json({
				id: APP_ID,
				slug: 'fabrika-acme',
				html_url: 'https://github.com/apps/fabrika-acme',
				permissions: { contents: 'read' },
				events: ['push'],
				owner: { login: 'acme', type: 'Organization' },
			})
		}
		if (method === 'PATCH' && url.pathname === '/app/hook/config') {
			const body: unknown = JSON.parse(String(init?.body))
			if (typeof body !== 'object' || body === null || !('url' in body) || !('secret' in body)) return new Response(null, { status: 422 })
			webhook.url = String(body.url)
			webhook.secret = String(body.secret)
			return Response.json({ url: webhook.url, content_type: 'json', insecure_ssl: '0' })
		}
		if (method === 'GET' && url.pathname === '/app/hook/config') {
			return Response.json({ url: webhook.url, content_type: 'json', insecure_ssl: '0' })
		}
		if (method === 'GET' && url.pathname === '/orgs/acme/installation') {
			return Response.json({
				id: INSTALLATION_ID,
				app_id: APP_ID,
				target_type: 'Organization',
				account: { login: 'acme', type: 'Organization' },
				repository_selection: 'all',
			})
		}
		const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname)
		if (method === 'POST' && mint !== null) {
			mints.push({ installationId: Number(mint[1]), body: JSON.parse(String(init?.body)) })
			return Response.json({ token: `ghs_${APP_ID}_${mint[1]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
		}
		return new Response(null, { status: 404 })
	}
	return { fetch, webhook, mints }
}

function workerBindings(harness: Harness): WorkerBindings {
	const unexpected = (): never => {
		throw new Error('unexpected binding access')
	}
	return {
		ENVIRONMENT: 'stage',
		DB: harness.d1,
		ASSETS: { fetch: unexpected, connect: unexpected },
		RUN_LOGS: {
			head: unexpected,
			get: unexpected,
			put: unexpected,
			createMultipartUpload: unexpected,
			resumeMultipartUpload: unexpected,
			delete: unexpected,
			list: unexpected,
		},
		DEPLOY_QUEUE: { send: unexpected, sendBatch: unexpected, metrics: unexpected },
		FABRIKA_CONTROL_DOMAIN: ORIGIN,
		FABRIKA_CONTROL_VAULT_KEY: vaultKey(),
		FABRIKA_RUNNER_KEY: 'test-runner-key',
		CLOUDFLARE_ACCOUNT_ID: 'account',
		CLOUDFLARE_API_TOKEN: 'token',
	}
}

function human(): AuthContext {
	return {
		ok: true,
		principal: { id: 'user-1', type: 'user', label: 'admin@example.test' },
		can: () => true,
		scopedTo: () => null,
		audit: () => Promise.resolve(),
	}
}

const envelope = <T>(codec: { version: number; encode(value: T): ProviderEnvelope['payload'] }, value: T): ProviderEnvelope => ({
	provider: 'cloudflare',
	version: codec.version,
	payload: codec.encode(value),
})

function rpcRequest(method: string, input: unknown): Request {
	return new Request(`${ORIGIN}/api/rpc`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: ORIGIN, [PROXY_TOKEN_HEADER]: adminToken },
		body: JSON.stringify({ method, input }),
	})
}

describe('Cloudflare vault-backed GitHub connections', () => {
	test('connect from the console, bind an app, trigger it by its scoped webhook, and mint its repository token', async () => {
		const harness = createHarness()
		const github = githubAppDouble()
		const metadataTokens: Array<string | null> = []
		const seams: CloudflareSourceSeams = {
			githubAppFetch: github.fetch,
			metadataFetch: async (_url, init) => {
				metadataTokens.push(new Headers(init?.headers).get('authorization'))
				return Response.json({ sha: COMMIT })
			},
		}
		const sent: ControlJobMessage[] = []
		const bindings = workerBindings(harness)
		const env: Env = {
			...controlEnv(bindings, () => {}),
			...testIamEnv,
			DEPLOY_QUEUE: {
				send: (message) => {
					sent.push(message)
					return Promise.resolve()
				},
			},
		}
		const sourceConnection = createSourceConnections({
			provider: 'cloudflare',
			vault: () => vault(env),
			createClient: gitHubAppClientFactory(github.fetch),
		})
		const provider = cloudflareControlProvider(bindings, env, seams)
		const fetch = (request: Request) => controlApp.fetch(request, { env, provider, sourceConnection }, { waitUntil() {} })
		try {
			const workflow = (request: Request) => ({
				env,
				source: sourceConnection,
				auth: human(),
				request,
				randomBytes: (n: number) => new Uint8Array(n).fill(7),
			})
			const started = await startSourceConnection(
				workflow(new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers: { origin: ORIGIN } })),
				{ organization: 'acme', appName: 'fabrika-acme', visibility: 'private', repositories: [] },
			)
			const state = btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
			const callback = await manifestCallback({
				...workflow(new Request(`${ORIGIN}/api/source/github/callback?code=created&state=${state}`)),
				exchangeManifest: async () => ({
					id: APP_ID,
					slug: 'fabrika-acme',
					htmlUrl: 'https://github.com/apps/fabrika-acme',
					pem: await appPrivateKeyPem(),
					webhookSecret: 'manifest-secret-is-replaced',
				}),
			})
			expect(callback.status).toBe(303)
			const connected = await verifySourceInstallation(
				workflow(new Request(`${ORIGIN}/api/rpc`, { method: 'POST', headers: { origin: ORIGIN } })),
				started.connectionId,
			)
			expect(connected).toMatchObject({ state: 'connected', connectionId: started.connectionId, installation: { id: INSTALLATION_ID } })
			expect(github.webhook.url).toBe(`${ORIGIN}/webhooks/github/${started.connectionId}`)
			expect(github.webhook.secret).not.toBe('')

			const registered = await fetch(rpcRequest('register', {
				id: 'app',
				repoUrl: 'https://github.com/acme/app',
				env: 'prod',
				triggerRef: 'refs/heads/main',
				target: envelope(cloudflareStoredTargetCodec, { stateNamespace: 'app-state' }),
				artifact: envelope(cloudflareArtifactCodec, cloudflareArtifact('fabrika.config.ts')),
				resolveInstallationId: true,
			}))
			expect(registered.status).toBe(200)
			expect(await env.REPOSITORIES.registry.getApp('app')).toMatchObject({
				github_connection_id: started.connectionId,
				github_installation_id: INSTALLATION_ID,
			})

			const push = async (path: string) => {
				const signed = await pushWebhookRequest({
					ref: 'refs/heads/main',
					cloneUrl: 'https://github.com/acme/app.git',
					after: COMMIT,
					installationId: INSTALLATION_ID,
					secret: github.webhook.secret,
				})
				return fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: signed.headers, body: await signed.text() }))
			}
			expect((await push('/webhooks/github')).status).toBe(404)
			expect((await push('/webhooks/github/another-connection')).status).toBe(401)
			expect(sent).toEqual([])
			expect((await push(`/webhooks/github/${started.connectionId}`)).status).toBe(200)
			expect(sent).toHaveLength(1)
			const [run] = await env.REPOSITORIES.runs.listRuns({ limit: 10 })
			expect(run).toMatchObject({ app_id: 'app', env: 'prod', trigger: 'webhook', ref: 'refs/heads/main', commit_sha: COMMIT })

			const sourceBinding = await env.REPOSITORIES.registry.getSourceBinding('app')
			expect(sourceBinding).toEqual({ connectionId: started.connectionId, installationId: INSTALLATION_ID })
			if (sourceBinding === null || provider.resolveSource === undefined) throw new Error('expected a private Cloudflare source')
			const signal = new AbortController().signal
			const app = { id: 'app', source: { repoUrl: 'github.com/acme/app', ref: 'refs/heads/main' } }
			const environment = {
				appId: 'app',
				env: 'prod',
				target: envelope(cloudflareStoredTargetCodec, { stateNamespace: 'app-state' }),
				artifact: envelope(cloudflareArtifactCodec, cloudflareArtifact('fabrika.config.ts')),
			}
			expect(await provider.resolveSource({ runId: 'run-1', app, environment, sourceBinding, signal })).toEqual({ commitSha: COMMIT })
			expect(metadataTokens).toEqual([`Bearer ghs_${APP_ID}_${INSTALLATION_ID}`])
			const clone = await cloudflareGitHubSource(env, seams).prepareClone({ ...app.source, ref: COMMIT }, signal, sourceBinding)
			expect(clone.repoUrl).toBe(`https://x-access-token:ghs_${APP_ID}_${INSTALLATION_ID}@github.com/acme/app`)
			expect(github.mints).toEqual([
				{ installationId: INSTALLATION_ID, body: { repositories: ['app'], permissions: { contents: 'read' } } },
				{ installationId: INSTALLATION_ID, body: { repositories: ['app'], permissions: { contents: 'read' } } },
			])
		} finally {
			harness.sqlite.close()
		}
	})
})
