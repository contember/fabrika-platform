/**
 * Test doubles. The IAM service is faked at the `IamGateway` boundary — the same seam the Cloudflare
 * binding plugs into — so nothing here needs a live service, a database or a network.
 *
 * Tokens are really signed with a real ES256 key and really verified through jose, because "the token
 * verifies" is the property under test everywhere; only the *transport* to IAM is faked.
 */

import {
	buildAccessClaims,
	buildResourceAccessClaims,
	type EndpointRequirement,
	type ExchangeAuthCodeResult,
	type InstallationCredentialedEndpoint,
	type InstallationEndpointRow,
	type Jwks,
	type MintFromKeyResult,
	type MintTokenResult,
	type OAuthEndpointScopes,
	type PermissionEntry,
	requirementDigest,
	RESOURCE_ACCESS_TOKEN_TYP,
	type TokenPrincipalType,
} from '@fabrika/auth-core'
import { exportJWK, generateKeyPair, type KeyLike, SignJWT } from 'jose'
import {
	APP_QUERY_PARAM,
	DEFAULT_VERIFY_PATH,
	FORWARDED_HOST_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_PROTO_HEADER,
	FORWARDED_URI_HEADER,
} from '../constants'
import { NO_CSP_ORIGINS } from '../headers'
import type { IamGateway } from '../iam'
import type { LogFields, ProxyLogger } from '../log'
import type {
	ContractProxyApp,
	DeclaredProxyEndpointRow,
	InstallationProxyApp,
	InstallationProxyEndpointRow,
	OAuthProtectedResource,
	ProxyEndpointRow,
	ProxyManifest,
} from '../manifest'

export const ISSUER = 'https://iam.test'
export const APP = 'example-app'
export const HOST = 'app.example.com'

export const PERMS: PermissionEntry[] = [{ action: 'demo.read', scope: null, source: 'grant' }]

export const RESOURCE = `https://${HOST}/mcp`
export const RESOURCE_METADATA = `https://${HOST}/.well-known/oauth-protected-resource/mcp`
export const OAUTH_RESOURCE: OAuthProtectedResource = {
	resource: RESOURCE,
	resourceMetadata: RESOURCE_METADATA,
	authorizationServers: [ISSUER],
	scopesSupported: ['mcp:read', 'mcp:write'],
}

// One ES256 key pair for the suite; `publicJwks` is what a healthy IAM serves.
const primary = await generateKeyPair('ES256')
/** A key that is NEVER published — tokens signed with it must fail verification. */
const foreign = await generateKeyPair('ES256')
/** A key ROTATED IN: unpublished until a test serves `ROTATED_JWKS`, after which it must verify. */
const rotated = await generateKeyPair('ES256')

export const privateKey = primary.privateKey
export const foreignPrivateKey = foreign.privateKey
export const rotatedPrivateKey = rotated.privateKey

async function jwksOf(key: KeyLike, kid: string): Promise<Jwks> {
	const jwk = await exportJWK(key)
	return { keys: [{ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' }] }
}

export const PUBLIC_JWKS: Jwks = await jwksOf(primary.publicKey, 'k1')
/** What IAM serves AFTER a rotation: `k1` is gone and `rotatedPrivateKey` signs as `k2`. */
export const ROTATED_JWKS: Jwks = await jwksOf(rotated.publicKey, 'k2')

export interface SignOptions {
	ttlSeconds?: number
	subject?: string
	/** Omit for an ANONYMOUS token (a standalone share link). */
	type?: TokenPrincipalType
	/** The workload a `job`, `webhook` or `app` token names. */
	workload?: string
	audience?: string
	issuer?: string
	key?: KeyLike
	kid?: string
	permissions?: PermissionEntry[]
}

export async function signToken(options: SignOptions = {}): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const claims = buildAccessClaims({
		iss: options.issuer ?? ISSUER,
		app: options.audience ?? APP,
		subject: options.subject ?? 'user-1',
		...(options.type === undefined ? {} : { type: options.type }),
		...(options.workload === undefined ? {} : { workload: options.workload }),
		label: 'a@b.cz',
		permissions: options.permissions ?? PERMS,
		issuedAt: now,
		expiresAt: now + (options.ttlSeconds ?? 300),
	})
	return new SignJWT({ ...claims })
		.setProtectedHeader({ alg: 'ES256', kid: options.kid ?? 'k1' })
		.sign(options.key ?? primary.privateKey)
}

export interface ResourceSignOptions {
	app?: string
	resource?: string
	scopes?: string[]
	/** `null` signs without a `typ` header. */
	typ?: string | null
	ttlSeconds?: number
	key?: KeyLike
}

/** An OAuth resource access token, as IAM's token endpoint mints it for an MCP client. */
export async function signResourceToken(options: ResourceSignOptions = {}): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const claims = buildResourceAccessClaims({
		iss: ISSUER,
		app: options.app ?? APP,
		resource: options.resource ?? RESOURCE,
		subject: 'user-1',
		label: 'a@b.cz',
		permissions: PERMS,
		issuedAt: now,
		expiresAt: now + (options.ttlSeconds ?? 300),
		clientId: 'https://client.example.com/metadata.json',
		scopes: options.scopes ?? ['mcp:read'],
		grantId: 'grant-1',
		tokenId: 'token-1',
	})
	const typ = options.typ === undefined ? RESOURCE_ACCESS_TOKEN_TYP : options.typ
	const header = typ === null ? { alg: 'ES256', kid: 'k1' } : { alg: 'ES256', kid: 'k1', typ }
	return new SignJWT(claims).setProtectedHeader(header).sign(options.key ?? primary.privateKey)
}

/** A token whose claims no builder would write: a payload signed as it is, with the suite's published key. */
export function signRawClaims(claims: Record<string, unknown>): Promise<string> {
	return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).sign(primary.privateKey)
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
	/** The app id each mint asked for — the audience the proxy mints under. */
	readonly seenApps: string[] = []
	readonly seenSessions: string[] = []
	readonly seenKeys: string[] = []
	readonly seenCodes: string[] = []
	readonly seenVerifiers: string[] = []

	constructor(private readonly options: FakeIamOptions = {}) {}

	mintToken(input: { app: string; session: string | null }): Promise<MintTokenResult> {
		this.mintTokenCalls++
		this.seenApps.push(input.app)
		if (input.session !== null) {
			this.seenSessions.push(input.session)
		}
		if (this.options.unreachable === true) {
			return Promise.reject(new Error('connect ECONNREFUSED'))
		}
		const canned = this.options.mintToken
		return Promise.resolve(typeof canned === 'function' ? canned() : (canned ?? { ok: false, reason: 'no_session' }))
	}

	mintFromKey(input: { app: string; key: string }): Promise<MintFromKeyResult> {
		this.mintFromKeyCalls++
		this.seenApps.push(input.app)
		this.seenKeys.push(input.key)
		if (this.options.unreachable === true) {
			return Promise.reject(new Error('connect ECONNREFUSED'))
		}
		const canned = this.options.mintFromKey
		return Promise.resolve(typeof canned === 'function' ? canned() : (canned ?? { ok: false, reason: 'invalid_key' }))
	}

	exchangeAuthCode(input: { code: string; verifier: string }): Promise<ExchangeAuthCodeResult> {
		this.exchangeCalls++
		this.seenCodes.push(input.code)
		this.seenVerifiers.push(input.verifier)
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

type CredentialedRow = Extract<DeclaredProxyEndpointRow, { requirement: EndpointRequirement }>
type AnonymousRow = Extract<DeclaredProxyEndpointRow, { requirement: null }>

/** A credentialed manifest row with its true digest; `delegation` defaults to none. */
export function endpointRow(
	fields: Omit<CredentialedRow, 'digest' | 'delegation'>,
	delegation: CredentialedRow['delegation'] = null,
): DeclaredProxyEndpointRow {
	const rules = { ...fields, delegation }
	return { ...rules, digest: requirementDigest(rules) }
}

/** An anonymous manifest row (health, form, webhook, link shell) with its true digest. */
export function anonymousRow(fields: Omit<AnonymousRow, 'digest' | 'delegation' | 'callers' | 'requirement'>): DeclaredProxyEndpointRow {
	const callers: [] = []
	const rules = { ...fields, callers, requirement: null, delegation: null }
	return { ...rules, digest: requirementDigest(rules) }
}

export function contractAppWith(
	endpoints: ProxyEndpointRow[],
	reservedPrefixes: string[] = [],
	overrides: Partial<ContractProxyApp> = {},
): ContractProxyApp {
	return {
		id: APP,
		hosts: [HOST],
		upstream: 'app:3000',
		scheme: 'https',
		endpoints,
		reservedPrefixes,
		snapshot: `sha256:${'0'.repeat(64)}`,
		csp: NO_CSP_ORIGINS,
		...overrides,
	}
}

/** An installation manifest row with its true digest. */
export function installationRow(fields: InstallationEndpointRow): InstallationProxyEndpointRow {
	const rules = { ...fields, delegation: null }
	return { ...rules, digest: requirementDigest(rules) }
}

/** An installation entry: only platform composition writes the marker. */
export function installationAppWith(
	endpoints: InstallationProxyEndpointRow[],
	reservedPrefixes: string[] = [],
	overrides: Partial<InstallationProxyApp> = {},
): InstallationProxyApp {
	return { id: APP, hosts: [HOST], upstream: 'app:3000', scheme: 'https', installation: true, endpoints, reservedPrefixes, ...overrides }
}

/** An installation `service` row serving every method on `path`; its id is the path. */
export function serviceRow(
	path: string,
	callers: InstallationCredentialedEndpoint['callers'],
	oauth: OAuthEndpointScopes | null = null,
): InstallationProxyEndpointRow {
	return installationRow({ id: path, kind: 'service', method: '*', path, callers, requirement: { kind: 'authenticated' }, admission: null, oauth })
}

/** An installation `protocol` row serving every method on `path`: anonymous at the proxy. */
export function protocolRow(path: string): InstallationProxyEndpointRow {
	return installationRow({ id: path, kind: 'protocol', method: '*', path, callers: [], requirement: null, admission: null, oauth: null })
}

/** The `/mcp` row OAuth clients reach with a resource token carrying `mcp:read`; register `OAUTH_RESOURCE` beside it. */
export const MCP_ROW = serviceRow('/mcp', ['oauth'], { scopes: ['mcp:read'] })

/** A manifest of one installation entry on `HOST`. */
export function manifestWith(endpoints: InstallationProxyEndpointRow[], overrides: Partial<InstallationProxyApp> = {}): ProxyManifest {
	return { apps: [installationAppWith(endpoints, [], overrides)] }
}

export interface VerifyRequestOptions {
	/** The auth service endpoint the subrequest targets. Default `/verify`. */
	endpoint?: string
	path?: string
	/** Pass null to omit the forwarded method header. */
	method?: string | null
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
	const method = options.method === undefined ? 'GET' : options.method
	if (method !== null) {
		headers.set(FORWARDED_METHOD_HEADER, method)
	}
	headers.set(FORWARDED_PROTO_HEADER, options.proto ?? 'https')
	if (options.cookie !== undefined) {
		headers.set('Cookie', options.cookie)
	}
	if (options.bearer !== undefined) {
		headers.set('Authorization', `Bearer ${options.bearer}`)
	}
	const app = options.app === undefined ? APP : options.app
	const query = app === null ? '' : `?${APP_QUERY_PARAM}=${encodeURIComponent(app)}`
	return new Request(`http://127.0.0.1:9000${options.endpoint ?? DEFAULT_VERIFY_PATH}${query}`, { method: 'GET', headers })
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
