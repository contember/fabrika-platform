import { SESSION_COOKIE } from '@fabrika/auth-core'
import { uuidv7 } from '@fabrika/platform'
import { spyOn } from 'bun:test'
import type { IamRepositories } from '../../db'
import type { OAuthConfig } from '../../oauth-config'
import { handleOAuth } from '../../oauth-http'
import { pkceChallenge, randomToken } from '../../oidc'
import { hashToken } from '../../secret'
import type { Services } from '../../services'
import { makeServicesFor } from './harness'

export const ISSUER = 'http://localhost:18191'
export const RESOURCE = 'https://control.example.test/mcp'
export const REDIRECT_URI = 'https://claude.example.test/api/mcp/auth_callback'
export const SIGNING_ENV = { FABRIKA_IAM_SIGNING_KEYS: '', ENVIRONMENT: 'local' }

/**
 * One user with live grants at `control`, one IAM session, and one registered client whose CIMD is
 * served by a stubbed `fetch`. Each fixture gets a fresh client id, so the module-level metadata cache
 * never answers one test from another's document.
 */
export async function oauthFixture(
	repositories: IamRepositories,
	options: {
		document?: (clientId: string) => Record<string, unknown>
		failFetch?: boolean
		/** The first fetch never settles, even past its abort signal: a Workers fetch whose request was cancelled. */
		stallFirstFetch?: boolean
	} = {},
) {
	const principal = await repositories.principals.createUser(uuidv7(), `${uuidv7()}@example.test`)
	await repositories.grants.createGrant({
		principalId: principal.id,
		app: 'control',
		permissions: ['source.workspace.read', 'source.workspace.write', 'deploy.run'],
		scopeType: 'app',
		scopeValue: 'alpha',
	})
	const sessionToken = randomToken(32)
	const sessionId = await repositories.sessions.createSession({
		tokenHash: await hashToken(sessionToken),
		principalId: principal.id,
		authenticationMethod: 'password',
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
	})
	const clientId = `https://claude.example.test/cimd/${uuidv7()}`
	const config: OAuthConfig = {
		clients: [{ provider: 'claude', clientId, redirectUris: [REDIRECT_URI], metadataUrl: clientId }],
		resources: [{
			app: 'control',
			resource: RESOURCE,
			defaultScopes: ['authoring'],
			scopeGrants: [
				{ scope: 'authoring', permissions: [{ action: 'source.workspace.*' }] },
				{ scope: 'deploy', permissions: [{ action: 'deploy.run', scope: { type: 'app', value: 'beta' } }] },
			],
		}],
	}
	const document = options.document?.(clientId) ?? {
		client_id: clientId,
		client_name: 'Claude <test>',
		redirect_uris: [REDIRECT_URI],
		token_endpoint_auth_method: 'none',
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
	}
	const fetched: string[] = []
	const nativeFetch = globalThis.fetch
	const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
		(input: Parameters<typeof fetch>[0]) => {
			fetched.push(input instanceof Request ? input.url : String(input))
			if (options.stallFirstFetch === true && fetched.length === 1) return new Promise<Response>(() => {})
			return Promise.resolve(options.failFetch === true ? new Response('unavailable', { status: 503 }) : Response.json(document))
		},
		{ preconnect: nativeFetch.preconnect },
	))
	const services: Services = makeServicesFor(repositories, {
		issuer: ISSUER,
		authentication: { oidc: false, password: true },
		oauth: config,
	})
	const verifier = randomToken(32)
	const authorization: Record<string, string> = {
		response_type: 'code',
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		resource: RESOURCE,
		scope: 'authoring',
		state: 'opaque-state',
		code_challenge: await pkceChallenge(verifier),
		code_challenge_method: 'S256',
	}
	const cookie = `${SESSION_COOKIE}=${sessionToken}`

	const call = (request: Request) => handleOAuth(request, services, SIGNING_ENV, 'req-oauth')

	function authorize(overrides: Record<string, string> = {}, withSession = true): Promise<Response> {
		return call(
			new Request(`${ISSUER}/oauth/authorize?${new URLSearchParams({ ...authorization, ...overrides })}`, {
				headers: withSession ? { cookie } : {},
			}),
		)
	}

	function decide(decision: string, overrides: Record<string, string> = {}, headers: Record<string, string> = {}): Promise<Response> {
		return call(
			new Request(`${ISSUER}/oauth/authorize`, {
				method: 'POST',
				headers: {
					cookie,
					origin: 'null',
					'sec-fetch-site': 'same-origin',
					'content-type': 'application/x-www-form-urlencoded',
					...headers,
				},
				body: new URLSearchParams({ ...authorization, ...overrides, decision }),
			}),
		)
	}

	async function approve(): Promise<string> {
		const response = await decide('approve')
		const location = response.headers.get('location')
		const code = location === null ? null : new URL(location).searchParams.get('code')
		if (code === null) throw new Error(`consent did not issue a code (${response.status})`)
		return code
	}

	function post(path: string, form: Record<string, string>): Promise<Response> {
		return call(
			new Request(`${ISSUER}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(form),
			}),
		)
	}

	function exchange(code: string, overrides: Record<string, string> = {}): Promise<Response> {
		return post('/oauth/token', {
			grant_type: 'authorization_code',
			client_id: clientId,
			code,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
			resource: RESOURCE,
			...overrides,
		})
	}

	function refresh(refreshToken: string, overrides: Record<string, string> = {}): Promise<Response> {
		return post('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: RESOURCE, ...overrides })
	}

	return {
		repositories,
		principal,
		sessionId,
		clientId,
		config,
		services,
		fetched,
		restoreFetch: () => fetchSpy.mockRestore(),
		call,
		authorize,
		decide,
		approve,
		exchange,
		refresh,
		post,
	}
}

export async function tokenBody(response: Response): Promise<{ access_token: string; refresh_token?: string; scope: string; expires_in: number }> {
	const body: unknown = await response.json()
	if (typeof body !== 'object' || body === null) throw new Error('token response is not an object')
	const access = Reflect.get(body, 'access_token')
	const refresh = Reflect.get(body, 'refresh_token')
	const scope = Reflect.get(body, 'scope')
	const expiresIn = Reflect.get(body, 'expires_in')
	if (typeof access !== 'string' || typeof scope !== 'string' || typeof expiresIn !== 'number') {
		throw new Error(`unexpected token response ${response.status}`)
	}
	return { access_token: access, scope, expires_in: expiresIn, ...(typeof refresh === 'string' ? { refresh_token: refresh } : {}) }
}
