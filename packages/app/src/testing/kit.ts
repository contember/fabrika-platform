// The test kit of a contract application: the application booted in-process behind a stand-in for IAM and the
// production proxy decision. A request takes the production path — proxy-core's verify service over the contract's
// endpoint table, a token signed the way IAM signs it, the proxy's header stripping, `X-Fabrika-Endpoint` — into the
// real `boot` and its dispatcher.

import {
	API_KEY_PREFIX,
	buildAccessClaims,
	CLIENT_ADDRESS_HEADER,
	type ContractArtifact,
	contractDigest,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_APP_ID,
	FABRIKA_IAM_ISSUER,
	type IamMembershipRpc,
	type Jwks,
	MAX_ACCESS_TOKEN_BYTES,
	PROXY_TOKEN_HEADER,
	SESSION_COOKIE,
	TOKEN_ALG,
	UNTRUSTED_FORWARD_HEADERS,
} from '@fabrika/auth-core'
import type { Database } from '@fabrika/db'
import { refuseInProduction } from '@fabrika/db/production'
import type { FileObjectStore } from '@fabrika/platform'
import { type IamGateway, REQUEST_ID_HEADER, stripFabrikaCookies } from '@fabrika/proxy-core'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { RpcFetch } from '../client/transport'
import { compileContract } from '../contract/compile'
import type { AnyContract } from '../contract/define'
import { boot, type ContractApp } from '../implement/boot'
import { type ConnectFetch, connectVariables } from '../implement/connect'
import type { SpaAssets } from '../implement/dispatch'
import type { ApplicationEnvironment, ContractImplementation } from '../implement/implement'
import { resolveGrants, type TestCaller, type TestCallerOptions, type TestGrant } from './caller'
import { endpointProxy } from './proxy'

export const TEST_ISSUER = 'https://iam.test'
export const TEST_ENVIRONMENT = 'test'
const KEY_ID = 'test-key'
const TOKEN_TTL_SECONDS = 300

export interface TestKitOptions {
	/** The application's own variables, as `deps` receives them. */
	readonly env?: ApplicationEnvironment
	/** Serves the SPA mounts. Defaults to an empty HTML document for every path. */
	readonly assets?: SpaAssets
	/** The connection a `scoped(tables)` database is bound to, as the runtime adapter supplies it to `boot`. */
	readonly database?: Database
	/** The object storage of the file collections, as the runtime adapter supplies it to `boot`. */
	readonly files?: FileObjectStore
	/**
	 * IAM's membership operations, for an application that creates scopes, manages members or issues share links:
	 * `boot` asks it as the adapter's transport, and the kit's proxy obtains each delegation grant from it.
	 */
	readonly membership?: IamMembershipRpc
	/**
	 * Each import's owner, by the import's name: its origin and edge key, which the platform writes as the import's
	 * framework variables, and how a request reaches it — usually the owner kit's `fetch`.
	 */
	readonly connect?: Readonly<Record<string, TestConnection>>
}

export interface TestConnection {
	readonly origin: string
	readonly key: string
	readonly fetch: ConnectFetch
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
	/** The test IAM as the proxy calls it: it mints for the credentials `testCaller` issued and serves their key set. */
	readonly iam: IamGateway
}

const defaultAssets: SpaAssets = {
	serve: () => Promise.resolve(new Response('<!doctype html><title></title>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
}

function toRequest(origin: string, input: RequestInfo | URL, init: RequestInit | undefined): Request {
	return input instanceof Request ? new Request(input, init) : new Request(new URL(input, origin), init)
}

/** Every header only the proxy may assert, deleted before the decision as Caddy and the proxy Worker delete them. */
function stripClientAsserted(headers: Headers): void {
	for (const header of [...headers.keys()]) {
		if (header.toLowerCase().startsWith('x-fabrika-')) {
			headers.delete(header)
		}
	}
	headers.delete(PROXY_TOKEN_HEADER)
	headers.delete(CLIENT_ADDRESS_HEADER)
	headers.delete(REQUEST_ID_HEADER)
	for (const header of UNTRUSTED_FORWARD_HEADERS) {
		headers.delete(header)
	}
}

/** Boots `app` the way its generated entrypoint would, behind the test proxy and IAM. Throws `BootError` like `boot`. */
export function testKit<C extends AnyContract>(app: ContractImplementation<C>, options: TestKitOptions = {}): TestKit<C> {
	refuseInProduction('@fabrika/app/testing')
	const name = app.contract.vocabulary.app
	const appId = `${name}@${TEST_ENVIRONMENT}`
	const host = `${name}.test`
	const origin = `https://${host}`
	const artifact = compileContract(app.contract, app.database?.tables ?? {})
	const signing = generateKeyPair(TOKEN_ALG)
	const jwks: Promise<Jwks> = signing.then(async ({ publicKey }) => {
		const { kty, crv, x, y } = await exportJWK(publicKey)
		if (kty === undefined) {
			throw new Error('the generated signing key exported no key type')
		}
		return { keys: [{ kty, crv, x, y, kid: KEY_ID, alg: TOKEN_ALG, use: 'sig' }] }
	})
	const connectVariablesOf: Record<string, string> = {}
	const connectBindings: Record<string, ConnectFetch> = {}
	for (const [name, connection] of Object.entries(options.connect ?? {})) {
		const variables = connectVariables(name)
		connectVariablesOf[variables.url] = connection.origin
		connectVariablesOf[variables.key] = connection.key
		connectBindings[variables.binding] = connection.fetch
	}
	const application: ContractApp = boot(app, {
		environment: {
			// The deploy writes the approved contract's digest; the kit's contract is the approved one by definition.
			framework: {
				[FABRIKA_IAM_APP_ID]: appId,
				[FABRIKA_IAM_ISSUER]: TEST_ISSUER,
				[FABRIKA_CONTRACT_DIGEST]: contractDigest(artifact),
				...connectVariablesOf,
			},
			application: options.env ?? {},
		},
		iam: { getJwks: () => jwks },
		assets: options.assets ?? defaultAssets,
		database: options.database,
		files: options.files,
		membership: options.membership,
		connectBindings,
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

	/** The caller's token, or `null` above `MAX_ACCESS_TOKEN_BYTES`, which IAM refuses to sign. */
	async function mint(caller: TestCaller): Promise<{ readonly token: string; readonly expiresAt: number } | null> {
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
		const token = await new SignJWT({ ...claims }).setProtectedHeader({ alg: TOKEN_ALG, kid: KEY_ID }).sign(privateKey)
		return token.length > MAX_ACCESS_TOKEN_BYTES ? null : { token, expiresAt: claims.exp }
	}

	const iam: IamGateway = {
		async mintToken({ app: audience, session }) {
			const caller = session === null || audience !== appId ? undefined : bySession.get(session)
			if (caller === undefined) {
				return { ok: false, reason: session === null ? 'no_session' : 'invalid_session' }
			}
			const minted = await mint(caller)
			return minted === null ? { ok: false, reason: 'token_too_large' } : { ok: true, ...minted }
		},
		async mintFromKey({ app: audience, key }) {
			const caller = audience === appId ? byKey.get(key) : undefined
			if (caller === undefined) {
				return { ok: false, reason: 'invalid_key' }
			}
			const minted = await mint(caller)
			return minted === null ? { ok: false, reason: 'token_too_large' } : { ok: true, ...minted }
		},
		// The kit issues sessions directly, so no handoff code exists to redeem.
		exchangeAuthCode: () => Promise.resolve({ ok: false, reason: 'invalid_code' }),
		getJwks: () => jwks,
	}

	const proxy = endpointProxy({ artifact, appId, host, iam, issuer: TEST_ISSUER, delegations: options.membership ?? null })

	const kitFetch: RpcFetch = async (input, init) => {
		const request = toRequest(origin, input, init)
		if (new URL(request.url).origin !== origin) {
			throw new TypeError(`the test kit serves only ${origin}, not ${new URL(request.url).origin}`)
		}
		const headers = new Headers(request.headers)
		stripClientAsserted(headers)
		const outcome = await proxy({ method: request.method, url: request.url, headers: new Headers(headers) })
		if (outcome.outcome === 'answer') {
			// The proxy's own answer carries its header policy, or the file treatment, as in production.
			return outcome.response
		}
		stripFabrikaCookies(headers)
		if (!outcome.keepsAuthorization) {
			headers.delete('Authorization')
		}
		for (const [header, value] of outcome.asserted) {
			headers.set(header, value)
		}
		return application.fetch(new Request(request, { headers }))
	}

	function browser(caller?: TestCaller): RpcFetch {
		if (caller !== undefined && caller.cookie === null) {
			throw new Error(`a browser carries a session; pass the ${caller.kind}'s key to createClient instead`)
		}
		return (input, init) => {
			const request = toRequest(origin, input, init)
			// Bun's Request does not keep its credentials mode, so `init` is the only reliable reading of it.
			const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : undefined)
			const headers = new Headers(request.headers)
			if (!headers.has('Sec-Fetch-Site')) {
				headers.set('Sec-Fetch-Site', 'same-origin')
			}
			if (!headers.has('Sec-Fetch-Mode')) {
				headers.set('Sec-Fetch-Mode', 'cors')
			}
			if (caller !== undefined && caller.cookie !== null && credentials !== 'omit') {
				const cookies = headers.get('Cookie')
				headers.set('Cookie', cookies === null || cookies === '' ? caller.cookie : `${cookies}; ${caller.cookie}`)
			}
			return kitFetch(new Request(request, { headers }))
		}
	}

	return Object.freeze({ origin, appId, artifact, testCaller, fetch: kitFetch, browser, iam })
}
