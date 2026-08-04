/**
 * Test doubles. The IAM service is faked at the `IamGateway` boundary — the same seam the Cloudflare
 * binding plugs into — so nothing here needs a live service, a database or a network.
 *
 * Tokens are really signed with a real ES256 key and really verified through jose, because "the token
 * verifies" is the property under test everywhere; only the *transport* to IAM is faked.
 */

import {
	type AppGates,
	buildAccessClaims,
	type ExchangeAuthCodeResult,
	type Jwks,
	type MintFromKeyResult,
	type MintTokenResult,
	type PermissionEntry,
} from '@fabrika/auth-core'
import type { ProxyApp, ProxyManifest } from '@fabrika/proxy-contract'
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose'
import {
	APP_QUERY_PARAM,
	DEFAULT_VERIFY_PATH,
	FORWARDED_HOST_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_PROTO_HEADER,
	FORWARDED_URI_HEADER,
} from '../constants'
import type { IamGateway } from '../iam'
import type { LogFields, ProxyLogger } from '../log'

export const ISSUER = 'https://iam.test'
export const APP = 'example-app'
export const HOST = 'app.example.com'

export const PERMS: PermissionEntry[] = [{ action: 'demo.read', scope: null, source: 'grant' }]

// One ES256 key pair for the suite; `publicJwks` is what a healthy IAM serves.
const primary = await generateKeyPair('ES256')
/** A key that is NEVER published — tokens signed with it must fail verification. */
const foreign = await generateKeyPair('ES256')

export const privateKey = primary.privateKey
export const foreignPrivateKey = foreign.privateKey

async function jwksOf(key: KeyLike, kid: string): Promise<Jwks> {
	const jwk = await exportJWK(key)
	return { keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' }] }
}

export const PUBLIC_JWKS: Jwks = await jwksOf(primary.publicKey, 'k1')

export interface SignOptions {
	ttlSeconds?: number
	subject?: string
	/** Omit for an ANONYMOUS token (a passthrough JWT / standalone share link). */
	type?: 'user' | 'service'
	audience?: string
	issuer?: string
	key?: KeyLike
	kid?: string
}

export async function signToken(options: SignOptions = {}): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const claims = buildAccessClaims({
		iss: options.issuer ?? ISSUER,
		app: options.audience ?? APP,
		subject: options.subject ?? 'user-1',
		...(options.type === undefined ? {} : { type: options.type }),
		label: 'a@b.cz',
		permissions: PERMS,
		issuedAt: now,
		expiresAt: now + (options.ttlSeconds ?? 300),
	})
	return new SignJWT({ ...claims })
		.setProtectedHeader({ alg: 'ES256', kid: options.kid ?? 'k1' })
		.sign(options.key ?? primary.privateKey)
}

/** A principal-bound token, i.e. what `mintToken` / `mintFromKey` return for a real caller. */
export function signUserToken(ttlSeconds = 300): Promise<string> {
	return signToken({ ttlSeconds, type: 'user' })
}

// ── The fake IAM ───────────────────────────────────────────────────────────────

export interface FakeIamOptions {
	mintToken?: MintTokenResult | (() => MintTokenResult)
	mintFromKey?: MintFromKeyResult | (() => MintFromKeyResult)
	exchangeAuthCode?: ExchangeAuthCodeResult | (() => ExchangeAuthCodeResult)
	jwks?: Jwks
	/** Make every call reject, as an unreachable service would. */
	unreachable?: boolean
	/** Fail ONLY the key set: a healthy mint surface whose JWKS cannot be fetched. */
	jwksUnreachable?: boolean
}

export class FakeIam implements IamGateway {
	mintTokenCalls = 0
	mintFromKeyCalls = 0
	jwksCalls = 0
	exchangeCalls = 0
	readonly seenSessions: string[] = []
	readonly seenKeys: string[] = []
	readonly seenCodes: string[] = []

	constructor(private readonly options: FakeIamOptions = {}) {}

	mintToken(input: { session: string | null }): Promise<MintTokenResult> {
		this.mintTokenCalls++
		if (input.session !== null) {
			this.seenSessions.push(input.session)
		}
		if (this.options.unreachable === true) {
			return Promise.reject(new Error('connect ECONNREFUSED'))
		}
		const canned = this.options.mintToken
		return Promise.resolve(typeof canned === 'function' ? canned() : (canned ?? { ok: false, reason: 'no_session' }))
	}

	mintFromKey(input: { key: string }): Promise<MintFromKeyResult> {
		this.mintFromKeyCalls++
		this.seenKeys.push(input.key)
		if (this.options.unreachable === true) {
			return Promise.reject(new Error('connect ECONNREFUSED'))
		}
		const canned = this.options.mintFromKey
		return Promise.resolve(typeof canned === 'function' ? canned() : (canned ?? { ok: false, reason: 'invalid_key' }))
	}

	exchangeAuthCode(input: { code: string }): Promise<ExchangeAuthCodeResult> {
		this.exchangeCalls++
		this.seenCodes.push(input.code)
		if (this.options.unreachable === true) {
			return Promise.reject(new Error('connect ECONNREFUSED'))
		}
		const canned = this.options.exchangeAuthCode
		return Promise.resolve(typeof canned === 'function' ? canned() : (canned ?? { ok: false, reason: 'invalid_code' }))
	}

	getJwks(): Promise<Jwks> {
		this.jwksCalls++
		if (this.options.unreachable === true || this.options.jwksUnreachable === true) {
			return Promise.reject(new Error('connect ECONNREFUSED'))
		}
		return Promise.resolve(this.options.jwks ?? PUBLIC_JWKS)
	}
}

// ── Manifest + request construction ────────────────────────────────────────────

export function appWith(gates: AppGates, overrides: Partial<ProxyApp> = {}): ProxyApp {
	return { id: APP, hosts: [HOST], upstream: 'app:3000', scheme: 'https', gates, ...overrides }
}

export function manifestWith(gates: AppGates, overrides: Partial<ProxyApp> = {}): ProxyManifest {
	return { apps: [appWith(gates, overrides)] }
}

export interface VerifyRequestOptions {
	path?: string
	method?: string
	host?: string
	proto?: string
	cookie?: string
	bearer?: string
	headers?: Record<string, string>
	/** Pin the app id the way the generated Caddy route does. Pass null to force host lookup. */
	app?: string | null
	/** Override/omit the forwarded URI header entirely. */
	forwardedUri?: string | null
	forwardedHost?: string | null
}

/** Build the `/verify` subrequest exactly as Caddy's `forward_auth` would issue it. */
export function verifyRequest(options: VerifyRequestOptions = {}): Request {
	const headers = new Headers(options.headers ?? {})
	const uri = options.forwardedUri === undefined ? (options.path ?? '/page') : options.forwardedUri
	if (uri !== null) {
		headers.set(FORWARDED_URI_HEADER, uri)
	}
	const host = options.forwardedHost === undefined ? (options.host ?? HOST) : options.forwardedHost
	if (host !== null) {
		headers.set(FORWARDED_HOST_HEADER, host)
	}
	headers.set(FORWARDED_METHOD_HEADER, options.method ?? 'GET')
	headers.set(FORWARDED_PROTO_HEADER, options.proto ?? 'https')
	if (options.cookie !== undefined) {
		headers.set('Cookie', options.cookie)
	}
	if (options.bearer !== undefined) {
		headers.set('Authorization', `Bearer ${options.bearer}`)
	}
	const app = options.app === undefined ? APP : options.app
	const query = app === null ? '' : `?${APP_QUERY_PARAM}=${encodeURIComponent(app)}`
	return new Request(`http://127.0.0.1:9000${DEFAULT_VERIFY_PATH}${query}`, { method: 'GET', headers })
}

// ── A logger that records everything, so tests can prove what was NOT written ──

export interface CapturedLine {
	level: string
	message: string
	fields: LogFields
}

export class CapturingLogger implements ProxyLogger {
	readonly lines: CapturedLine[] = []

	info(message: string, fields?: LogFields): void {
		this.lines.push({ level: 'info', message, fields: fields ?? {} })
	}

	warn(message: string, fields?: LogFields): void {
		this.lines.push({ level: 'warn', message, fields: fields ?? {} })
	}

	error(message: string, fields?: LogFields): void {
		this.lines.push({ level: 'error', message, fields: fields ?? {} })
	}

	/** Everything ever logged, flattened — the haystack a secret must not appear in. */
	dump(): string {
		return JSON.stringify(this.lines)
	}
}
