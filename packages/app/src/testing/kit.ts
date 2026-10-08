// The test kit of a contract application: the application booted in-process behind a stand-in for the proxy and
// IAM. A request takes the production path — the proxy's decision, a token signed the way IAM signs it, the proxy's
// header stripping — into the real `boot` and its dispatcher.

import {
	API_KEY_PREFIX,
	buildAccessClaims,
	type ContractArtifact,
	FABRIKA_COOKIE_PREFIX,
	FABRIKA_IAM_APP_ID,
	FABRIKA_IAM_ISSUER,
	type Jwks,
	PROXY_TOKEN_HEADER,
	rawRequestTarget,
	SESSION_COOKIE,
	TOKEN_ALG,
	UNTRUSTED_FORWARD_HEADERS,
} from '@fabrika/auth-core'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { RpcFetch } from '../client/transport'
import { compileContract } from '../contract/compile'
import type { AnyContract } from '../contract/define'
import { boot, type ContractApp } from '../implement/boot'
import type { SpaAssets } from '../implement/dispatch'
import { headerPolicy, withHeaderPolicy } from '../implement/headers'
import type { ApplicationEnvironment, ContractImplementation } from '../implement/implement'
import { resolveGrants, type TestCaller, type TestCallerOptions, type TestGrant } from './caller'
import { endpointDecision, type PresentedCredential, type ProxyDecision, type ProxyVerdict } from './proxy'

export const TEST_ISSUER = 'https://iam.test'
export const TEST_ENVIRONMENT = 'test'
const KEY_ID = 'test-key'
const TOKEN_TTL_SECONDS = 300

export interface TestKitOptions {
	/** The application's own variables, as `deps` receives them. */
	readonly env?: ApplicationEnvironment
	/** Serves the SPA mounts. Defaults to an empty HTML document for every path. */
	readonly assets?: SpaAssets
	/** Decides whether a request reaches the application. Defaults to `endpointDecision` over the contract. */
	readonly proxy?: ProxyDecision
}

export interface TestKit<C extends AnyContract> {
	/** The origin requests are resolved against, `https://<app>.test`. */
	readonly origin: string
	/** The token audience, `<app>@test`. */
	readonly appId: string
	/** The contract as compiled for `boot`. */
	readonly artifact: ContractArtifact
	/** A new principal of the test IAM holding `grants`, with a fresh credential. */
	testCaller(grants: readonly TestGrant<C>[], options?: TestCallerOptions): TestCaller
	/** A request as it reaches the proxy, credentials as written: a script, a `px_` key, or another site. */
	readonly fetch: RpcFetch
	/** `fetch` from a page of the application: same-origin, with the session cookie of `caller` when given. */
	browser(caller?: TestCaller): RpcFetch
}

const defaultAssets: SpaAssets = {
	serve: () => Promise.resolve(new Response('<!doctype html><title></title>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
}

const DENY_TEXT: Readonly<Record<400 | 401 | 403, string>> = { 400: 'bad request', 401: 'unauthorized', 403: 'forbidden' }

/** The bearer of an `Authorization` header, or `null`. */
function bearerOf(headers: Headers): string | null {
	const match = /^Bearer\s+(.+)$/i.exec(headers.get('Authorization')?.trim() ?? '')
	return match?.[1]?.trim() ?? null
}

function cookieValue(headers: Headers, name: string): string | null {
	for (const part of (headers.get('Cookie') ?? '').split(';')) {
		const eq = part.indexOf('=')
		if (eq !== -1 && part.slice(0, eq).trim() === name) {
			return part.slice(eq + 1).trim()
		}
	}
	return null
}

/** The `Cookie` header without the proxy's own cookies, which never reach the application. */
function applicationCookies(headers: Headers): string | null {
	const kept = (headers.get('Cookie') ?? '').split(';').map((part) => part.trim()).filter((part) =>
		part !== '' && !part.startsWith(FABRIKA_COOKIE_PREFIX)
	)
	return kept.length === 0 ? null : kept.join('; ')
}

/** A document navigation is told to sign in with a redirect; anything else with a 401 it can read. */
function isDocumentNavigation(headers: Headers): boolean {
	const mode = headers.get('Sec-Fetch-Mode')
	return mode === null || mode === 'navigate'
}

function toRequest(origin: string, input: RequestInfo | URL, init: RequestInit | undefined): Request {
	return input instanceof Request ? new Request(input, init) : new Request(new URL(input, origin), init)
}

/** Boots `app` the way its generated entrypoint would, behind the test proxy and IAM. Throws `BootError` like `boot`. */
export function testKit<C extends AnyContract>(app: ContractImplementation<C>, options: TestKitOptions = {}): TestKit<C> {
	const name = app.contract.vocabulary.app
	const appId = `${name}@${TEST_ENVIRONMENT}`
	const origin = `https://${name}.test`
	const artifact = compileContract(app.contract, app.database?.tables ?? {})
	const policy = headerPolicy(artifact.csp, null)
	const decide = options.proxy ?? endpointDecision(artifact)
	const signing = generateKeyPair(TOKEN_ALG)
	const jwks: Promise<Jwks> = signing.then(async ({ publicKey }) => {
		const { kty, crv, x, y } = await exportJWK(publicKey)
		if (kty === undefined) {
			throw new Error('the generated signing key exported no key type')
		}
		return { keys: [{ kty, crv, x, y, kid: KEY_ID, alg: TOKEN_ALG, use: 'sig' }] }
	})
	const application: ContractApp = boot(app, {
		environment: {
			framework: { [FABRIKA_IAM_APP_ID]: appId, [FABRIKA_IAM_ISSUER]: TEST_ISSUER },
			application: options.env ?? {},
		},
		iam: { getJwks: () => jwks },
		assets: options.assets ?? defaultAssets,
	})

	const byKey = new Map<string, TestCaller>()
	const bySession = new Map<string, TestCaller>()
	let issued = 0

	function testCaller(grants: readonly TestGrant<C>[], callerOptions: TestCallerOptions = {}): TestCaller {
		const kind = callerOptions.kind ?? 'human'
		const via = kind === 'human' ? (callerOptions.via ?? 'session') : 'key'
		issued += 1
		const credential = crypto.randomUUID().replaceAll('-', '')
		const caller: TestCaller = Object.freeze({
			kind,
			id: callerOptions.id ?? `${kind}-${issued}`,
			label: kind === 'link' ? null : (callerOptions.label ?? `${kind}-${issued}@${name}.test`),
			perms: Object.freeze(resolveGrants(app.contract, grants)),
			key: via === 'key' ? `${API_KEY_PREFIX}test_${credential}` : null,
			cookie: via === 'session' ? `${SESSION_COOKIE}=${credential}` : null,
		})
		if (caller.key !== null) {
			byKey.set(caller.key, caller)
		} else {
			bySession.set(credential, caller)
		}
		return caller
	}

	function presented(headers: Headers): PresentedCredential | null {
		const bearer = bearerOf(headers)
		if (bearer !== null) {
			return { via: 'key', caller: byKey.get(bearer) ?? null }
		}
		const session = cookieValue(headers, SESSION_COOKIE)
		return session === null ? null : { via: 'session', caller: bySession.get(session) ?? null }
	}

	async function mint(caller: TestCaller): Promise<string> {
		const now = Math.floor(Date.now() / 1000)
		const claims = buildAccessClaims({
			iss: TEST_ISSUER,
			app: appId,
			subject: caller.id,
			...(caller.kind === 'link' ? {} : { type: caller.kind === 'human' ? 'user' : 'service' }),
			label: caller.label,
			permissions: [...caller.perms],
			issuedAt: now,
			expiresAt: now + TOKEN_TTL_SECONDS,
		})
		const { privateKey } = await signing
		return new SignJWT({ ...claims }).setProtectedHeader({ alg: TOKEN_ALG, kid: KEY_ID }).sign(privateKey)
	}

	function refusal(verdict: Exclude<ProxyVerdict, { outcome: 'forward' }>, headers: Headers): Response {
		if (verdict.outcome === 'refuse') {
			return withHeaderPolicy(new Response(DENY_TEXT[verdict.status], { status: verdict.status, headers: { 'Content-Type': 'text/plain' } }), policy)
		}
		const loginUrl = `${TEST_ISSUER}/auth/login`
		const response = isDocumentNavigation(headers)
			? new Response(null, { status: 302, headers: { Location: loginUrl } })
			: Response.json({ error: { type: 'auth', message: 'Authentication required', loginUrl } }, { status: 401 })
		return withHeaderPolicy(response, policy)
	}

	/** What the application receives: no header a client may assert, no proxy cookie, and the token when there is a caller. */
	async function forwarded(request: Request, caller: TestCaller | null): Promise<Request> {
		const headers = new Headers(request.headers)
		for (const header of [...headers.keys()]) {
			if (header.toLowerCase().startsWith('x-fabrika-')) {
				headers.delete(header)
			}
		}
		for (const header of UNTRUSTED_FORWARD_HEADERS) {
			headers.delete(header)
		}
		const cookies = applicationCookies(headers)
		if (cookies === null) {
			headers.delete('Cookie')
		} else {
			headers.set('Cookie', cookies)
		}
		if (caller === null) {
			// An anonymous endpoint never receives a credential that arrived with the request.
			headers.delete('Authorization')
		} else {
			headers.set(PROXY_TOKEN_HEADER, await mint(caller))
		}
		const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer()
		return new Request(request.url, { method: request.method, headers, body })
	}

	const kitFetch: RpcFetch = async (input, init) => {
		const request = toRequest(origin, input, init)
		const verdict = decide({ method: request.method, rawPath: rawRequestTarget(request.url).pathname, credential: presented(request.headers) })
		if (verdict.outcome !== 'forward') {
			return refusal(verdict, request.headers)
		}
		return application.fetch(await forwarded(request, verdict.caller))
	}

	function browser(caller?: TestCaller): RpcFetch {
		if (caller !== undefined && caller.cookie === null) {
			throw new Error(`a browser carries a session; pass the ${caller.kind}'s key to createClient instead`)
		}
		return (input, init) => {
			const headers = new Headers(init?.headers)
			if (!headers.has('Sec-Fetch-Site')) {
				headers.set('Sec-Fetch-Site', 'same-origin')
			}
			if (!headers.has('Sec-Fetch-Mode')) {
				headers.set('Sec-Fetch-Mode', 'cors')
			}
			if (caller !== undefined && caller.cookie !== null && init?.credentials !== 'omit') {
				headers.set('Cookie', caller.cookie)
			}
			return kitFetch(input, { ...init, headers })
		}
	}

	return Object.freeze({ origin, appId, artifact, testCaller, fetch: kitFetch, browser })
}
