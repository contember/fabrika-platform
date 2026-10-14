/**
 * The propustka-issued token contract — the SECOND thing (after `IamRpc`) that must not drift
 * between the Worker and the SDK.
 *
 * Background: today a request is authorized by the Worker resolving a Cloudflare Access JWT on
 * every call over RPC (the CF token carries only identity, so authz needs a round-trip). When
 * propustka issues its OWN token it can embed the already-resolved permission set, and the SDK
 * authorizes LOCALLY — no per-request round-trip. This module is the wire shape of that token:
 *
 *   - the Worker BUILDS claims here and signs them (`buildAccessClaims`);
 *   - the SDK verifies the signature with jose, then PARSES the payload back into typed claims
 *     here (`parseAccessClaims`) — structurally, so it reads them without an `as` cast — and maps a
 *     principal-bound token into the `ResolvedPrincipal` the existing `AuthContext` consumes.
 *
 * ONE shape, no `kind` discriminator — the optional `ptype` carries the distinction. Every token carries
 * `perms: PermissionEntry[]` (authorized via `permits` — scopes + wildcards) and an OPTIONAL
 * principal (`ptype`): present means the token is bound to a user/service principal; absent means an
 * anonymous credential (a share link), whose `perms` are narrow scoped entries and
 * whose audit actor is `label`. `sub` is the subject id either way — a principal id when bound, else
 * the issuing credential id.
 *
 * Pure: no jose, no I/O. Signing/verifying (key material) stays in the packages that own it.
 */

import { numberField, prop, stringField } from './json'
import { isNormalizedMailbox } from './membership'
import { isCimdClientId, isOAuthResourceUri, parseOAuthScopes } from './oauth'
import type { ResolvedPrincipal } from './rpc'
import { isWorkloadKind, type PermissionEntry, type PermissionSource, type Scope, type TokenPrincipalType } from './types'

// ── Names & knobs on the wire (both sides agree) ───────────────────────────────

/** Namespace reserved for browser credentials owned by IAM and the Fabrika proxy. */
export const FABRIKA_COOKIE_PREFIX = '__Host-px_'

/**
 * Long-lived opaque session id, HOST-ONLY on whichever host wrote it — IAM's own at login, an app's
 * own after the proxy redeems a handoff code
 * ([ADR-0023](../../../docs/decisions/0023-one-session-per-host.md)). Same name, different host,
 * different `sessions` row.
 *
 * `__Host-` is a browser-enforced restatement of that: the prefix makes the browser refuse the cookie
 * unless it carries `Secure`, omits `Domain` and uses `Path=/`, so a sibling host under a shared
 * registrable domain cannot plant a second cookie of this name that the real host would then send
 * alongside its own. Measured, not assumed: Chromium accepts it over plain HTTP on `*.localhost`,
 * because those origins are potentially trustworthy.
 */
export const SESSION_COOKIE = `${FABRIKA_COOKIE_PREFIX}session`
/** Prefix marking a propustka opaque credential (API key / share link), e.g. `Bearer px_<random>`. */
export const API_KEY_PREFIX = 'px_'

/**
 * Where a job or a webhook exchanges its own `px_` key for an access token at IAM's public origin: `POST` with the key
 * as the bearer and `{ app }` as the body. IAM answers `MintFromKeyResult`, and only for a workload key of that app.
 */
export const WORKLOAD_TOKEN_PATH = '/auth/workload/token'

/** Signing algorithm propustka issues with and the SDK verifies (ECDSA P-256 — compact, ubiquitous). */
export const TOKEN_ALG = 'ES256'
/** JWT `typ` of an OAuth resource access token (RFC 9068). Native app tokens carry no `typ`. */
export const RESOURCE_ACCESS_TOKEN_TYP = 'at+jwt'

/** Default per-app access-token lifetime. Revocation/role changes take effect within this. */
export const DEFAULT_TOKEN_TTL_SECONDS = 300
/**
 * The SDK refreshes an access token this many seconds BEFORE it expires, so a request never rides a
 * token that expires mid-flight. Must be < the token TTL.
 */
export const TOKEN_REFRESH_SKEW_SECONDS = 30

/**
 * The largest access token IAM signs, in bytes (a JWT is ASCII). The proxy forwards it as one header,
 * and Bun's server, the application's runtime on Zerops, refuses a request whose headers exceed 16 KiB
 * in total; 8 KiB leaves the rest for the request's own headers and cookies. Caddy (1 MiB) and
 * Cloudflare (128 KiB) allow more.
 */
export const MAX_ACCESS_TOKEN_BYTES = 8192

// ── Claim shape (one, no discriminator) ────────────────────────────────────────

/**
 * The propustka access token. `perms` is always present (matched via `permits`); `ptype` is present
 * only when `sub` is a principal. `label` is the audit actor — the principal's label when bound, the
 * credential label otherwise (or null).
 */
export interface AccessTokenClaims {
	/** Issuer — propustka's own origin (e.g. `https://propustka.example.com`). */
	iss: string
	/** The app id this token is scoped to. The SDK REJECTS a token whose `aud` is not its app. */
	aud: string
	/** Subject id: a principal id when `ptype` is set, else the issuing credential id. */
	sub: string
	/** Issued-at (unix seconds). */
	iat: number
	/** Expiry (unix seconds). */
	exp: number
	/** Resolved/effective permissions; `can(action, scope?)` = `permits(perms, action, scope)`. */
	perms: PermissionEntry[]
	/** Present only when the token is bound to a principal (`sub` is that principal). */
	ptype?: TokenPrincipalType
	/**
	 * Present exactly when `ptype` is a workload kind: the job's or the webhook's name, or for `app` the id of the
	 * consuming application, which the proxy admits as the caller `app:<id>`.
	 */
	workload?: string
	/** Audit actor label — the principal's label, or the credential label, or null (anonymous). */
	label: string | null
	/**
	 * Only on a user token: the mailbox IAM recorded for the principal (`principals.email`, `normalizeEmailIdentity`).
	 * The signature authenticates that IAM recorded it, not that the person controls it. A user's `label` is that
	 * address as it was spelled, never a substitute for it.
	 */
	email?: string
	/** Present only on an OAuth resource token (`aud` is then a resource URI, not an app id). */
	oauth?: OAuthTokenClaims
	/** Present only on a share-link token, which has no `ptype`: `sub` is then the link key's id. */
	link?: LinkTokenClaims
}

/** What a share-link token adds: the link mount that issued the key and the chain the key is bound to. */
export interface LinkTokenClaims {
	mount: string
	/** The bound object first, then each value containing it, outward. */
	chain: Scope[]
}

/**
 * The principal kind of a token (ADR-0022 rule 3): a user or a service principal, a workload, or a share link. Null
 * for an anonymous credential that is not a link, which no contract mount admits.
 */
export type PrincipalKind = TokenPrincipalType | 'link'

export function principalKind(claims: AccessTokenClaims): PrincipalKind | null {
	if (claims.ptype !== undefined) return claims.ptype
	return claims.link === undefined ? null : 'link'
}

/** What an OAuth resource token adds: the signed app coordinate and the grant it was minted from. */
export interface OAuthTokenClaims {
	/** The app whose permissions `perms` are; `aud` names the resource URI instead. */
	app: string
	/** CIMD URL of the MCP client the user consented to. */
	clientId: string
	/** Consented scopes; `perms` is already narrowed by them. */
	scopes: string[]
	/** IAM's OAuth grant id — revoking it stops refresh. */
	grantId: string
	/** Unique token id, fresh on every mint. */
	tokenId: string
}

/** Which tokens a verifier accepts: native app tokens, or OAuth tokens minted for one resource of one app. */
export type TokenAudienceProfile = { kind: 'app'; app: string } | { kind: 'resource'; app: string; resource: string }

// ── Public JWKS (the SDK fetches this once, then verifies tokens locally) ───────
//
// Transport is the IAM service binding (`getJwks()` RPC), NOT a public HTTPS URL: app↔IAM is
// RPC over the binding, which never traverses the Access edge — so the SDK reaches the key set
// even while propustka's own hostname is still gated by Cloudflare Access. The Worker also
// serves the standard `/.well-known/jwks.json`, for when Access is gone. Both emit this shape.

/** A published public signing key (EC P-256 / ES256). A jose-compatible JWK subset. */
export interface PublicJwk {
	kty: string
	crv?: string
	x?: string
	y?: string
	kid?: string
	alg?: string
	use?: string
}

/** The public key set the SDK feeds to a local JWKS verifier. */
export interface Jwks {
	keys: PublicJwk[]
}

// ── Build (Worker side, pre-sign) ──────────────────────────────────────────────

export interface AccessTokenParams {
	/** Issuer (propustka origin). */
	iss: string
	/** App id this token is for (becomes `aud`). */
	app: string
	/** Subject id (becomes `sub`) — a principal id when `type` is given, else a credential id. */
	subject: string
	/** Principal type — omit for an anonymous credential (share link). */
	type?: TokenPrincipalType
	/** The workload's name; required with a workload `type`, refused with any other. */
	workload?: string
	/** Audit actor label, or null for an unlabeled anonymous token. */
	label: string | null
	/** A user principal's normalized mailbox; refused with any other `type`. */
	email?: string
	permissions: PermissionEntry[]
	issuedAt: number
	expiresAt: number
	/** A share-link key's mount and chain; only on a token without `type`. */
	link?: LinkTokenClaims
}

export interface ResourceAccessTokenParams {
	iss: string
	app: string
	resource: string
	subject: string
	label: string | null
	permissions: PermissionEntry[]
	issuedAt: number
	expiresAt: number
	clientId: string
	scopes: string[]
	grantId: string
	tokenId: string
}

/**
 * Assemble an OAuth resource access token. Always a user principal. The wire carries the standard
 * `client_id`/`scope`/`jti` claims plus Fabrika's `app` and `grant`; the caller signs with
 * `typ: RESOURCE_ACCESS_TOKEN_TYP`.
 */
export function buildResourceAccessClaims(params: ResourceAccessTokenParams): Record<string, unknown> {
	const payload = {
		iss: params.iss,
		aud: params.resource,
		sub: params.subject,
		iat: params.issuedAt,
		exp: params.expiresAt,
		perms: params.permissions,
		ptype: 'user',
		label: params.label,
		app: params.app,
		client_id: params.clientId,
		scope: params.scopes.join(' '),
		grant: params.grantId,
		jti: params.tokenId,
	}
	if (parseAccessClaims(payload)?.oauth === undefined) throw new Error('Invalid resource access token claims')
	return payload
}

/** A token is accepted only by the profile it was minted for: an app token never passes as a resource token, and vice versa. */
export function matchesTokenAudience(claims: AccessTokenClaims, profile: TokenAudienceProfile): boolean {
	if (profile.kind === 'app') return claims.oauth === undefined && claims.aud === profile.app
	return claims.oauth !== undefined && claims.aud === profile.resource && claims.oauth.app === profile.app
}

/** Assemble the claim object for an access token. Pure — the caller signs the result. */
export function buildAccessClaims(params: AccessTokenParams): AccessTokenClaims {
	const claims: AccessTokenClaims = {
		iss: params.iss,
		aud: params.app,
		sub: params.subject,
		iat: params.issuedAt,
		exp: params.expiresAt,
		perms: params.permissions,
		label: params.label,
	}
	if (params.type !== undefined) {
		claims.ptype = params.type
	}
	if (isWorkloadKind(params.type) !== (params.workload !== undefined) || (params.workload !== undefined && !isWorkloadName(params.workload))) {
		throw new Error('A workload token names its workload, and only a workload token does')
	}
	if (params.workload !== undefined) {
		claims.workload = params.workload
	}
	if (params.email !== undefined) {
		if (params.type !== 'user' || !isNormalizedMailbox(params.email)) {
			throw new Error('Only a user token carries a mailbox, and only a normalized one')
		}
		claims.email = params.email
	}
	if (params.link !== undefined) {
		if (params.type !== undefined) throw new Error('A share-link token has no principal type')
		claims.link = { mount: params.link.mount, chain: params.link.chain.map((scope) => ({ type: scope.type, value: scope.value })) }
	}
	return claims
}

// ── Parse (SDK side, post-verify) ──────────────────────────────────────────────

/**
 * Narrow a verified JWT payload into typed access-token claims WITHOUT trusting its shape. jose has
 * already checked the signature, `exp`, and `aud`; this validates the custom claims structurally so
 * the SDK reads them without an `as` cast. Returns null on any malformed claim shape.
 */
export function parseAccessClaims(payload: unknown): AccessTokenClaims | null {
	const iss = stringField(payload, 'iss')
	const aud = stringField(payload, 'aud')
	const sub = stringField(payload, 'sub')
	const iat = numberField(payload, 'iat')
	const exp = numberField(payload, 'exp')
	const perms = parsePermissionEntries(prop(payload, 'perms'))
	const label = parseNullableString(prop(payload, 'label'))
	const ptype = parseOptionalPrincipalType(prop(payload, 'ptype'))
	if (iss === undefined || aud === undefined || sub === undefined || iat === undefined || exp === undefined) {
		return null
	}
	if (perms === null || label === undefined || ptype === undefined) {
		return null
	}
	const oauth = parseOAuthClaims(payload)
	if (oauth === undefined || (oauth !== null && (ptype !== 'user' || !isOAuthResourceUri(aud)))) {
		return null
	}
	const link = parseLinkClaims(prop(payload, 'link'))
	if (link === undefined || (link !== null && (ptype !== null || oauth !== null))) {
		return null
	}
	const workload = parseWorkload(prop(payload, 'workload'), ptype)
	if (workload === undefined) {
		return null
	}
	const email = parseEmail(prop(payload, 'email'), ptype)
	if (email === undefined) {
		return null
	}
	const claims: AccessTokenClaims = { iss, aud, sub, iat, exp, perms, label }
	if (ptype !== null) {
		claims.ptype = ptype
	}
	if (workload !== null) {
		claims.workload = workload
	}
	if (email !== null) {
		claims.email = email
	}
	if (oauth !== null) {
		claims.oauth = oauth
	}
	if (link !== null) {
		claims.link = link
	}
	return claims
}

/** A job, webhook or mount name, or an application id. */
const WORKLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function isWorkloadName(value: string): boolean {
	return WORKLOAD_NAME.test(value)
}

/** A workload kind requires its name and every other kind refuses one: the name → the name, none → null, else undefined. */
function parseWorkload(value: unknown, ptype: TokenPrincipalType | null): string | null | undefined {
	if (!isWorkloadKind(ptype)) {
		return value === undefined ? null : undefined
	}
	return typeof value === 'string' && isWorkloadName(value) ? value : undefined
}

/** Absent → null; a normalized mailbox on a user token → it; anything else → undefined. */
function parseEmail(value: unknown, ptype: TokenPrincipalType | null): string | null | undefined {
	if (value === undefined) {
		return null
	}
	return ptype === 'user' && typeof value === 'string' && isNormalizedMailbox(value) ? value : undefined
}

/** Absent → null; a mount and a non-empty chain → the claims; anything else → undefined. */
function parseLinkClaims(value: unknown): LinkTokenClaims | null | undefined {
	if (value === undefined) {
		return null
	}
	const mount = stringField(value, 'mount')
	const rawChain = prop(value, 'chain')
	if (mount === undefined || mount === '' || !Array.isArray(rawChain) || rawChain.length === 0) {
		return undefined
	}
	const chain: Scope[] = []
	for (const item of rawChain) {
		const scope = parseScope(item)
		if (scope === null || scope === undefined) {
			return undefined
		}
		chain.push(scope)
	}
	return { mount, chain }
}

/** Absent OAuth claims → null; complete and valid → the claims; partial or malformed → undefined. */
function parseOAuthClaims(payload: unknown): OAuthTokenClaims | null | undefined {
	const app = prop(payload, 'app')
	const clientId = prop(payload, 'client_id')
	const scope = prop(payload, 'scope')
	const grantId = prop(payload, 'grant')
	const tokenId = prop(payload, 'jti')
	if (app === undefined && clientId === undefined && scope === undefined && grantId === undefined && tokenId === undefined) {
		return null
	}
	const scopes = typeof scope === 'string' ? parseOAuthScopes(scope.split(' ')) : null
	if (
		typeof app !== 'string' || app === '' || !isCimdClientId(clientId) || scopes === null || typeof grantId !== 'string' || grantId === ''
		|| typeof tokenId !== 'string' || tokenId === ''
	) {
		return undefined
	}
	return { app, clientId, scopes, grantId, tokenId }
}

/**
 * Map a verified PRINCIPAL-bound access token into the `ResolvedPrincipal` the existing
 * `AuthContext` consumes. Returns null for an anonymous token (no `ptype`) and for a workload token,
 * which no `AuthContext` represents — the caller handles both separately.
 */
export function accessClaimsToResolved(claims: AccessTokenClaims, requestId: string): ResolvedPrincipal | null {
	if (claims.ptype === undefined || isWorkloadKind(claims.ptype)) {
		return null
	}
	return {
		id: claims.sub,
		type: claims.ptype,
		label: claims.label ?? claims.sub,
		permissions: claims.perms,
		requestId,
	}
}

// ── Structural parsers (no `as`) ───────────────────────────────────────────────

/** Read `ptype`: a valid principal kind, explicit-absent (→ null), or malformed or unknown (→ undefined). */
function parseOptionalPrincipalType(value: unknown): TokenPrincipalType | null | undefined {
	if (value === undefined || value === null) {
		return null
	}
	return value === 'user' || value === 'service' || isWorkloadKind(value) ? value : undefined
}

/** Accept a string or explicit-null/absent (→ null); reject any other type (→ undefined). */
function parseNullableString(value: unknown): string | null | undefined {
	if (value === null || value === undefined) {
		return null
	}
	return typeof value === 'string' ? value : undefined
}

function parseScope(value: unknown): Scope | null | undefined {
	if (value === null) {
		return null
	}
	const type = stringField(value, 'type')
	const scopeValue = stringField(value, 'value')
	if (type === undefined || scopeValue === undefined) {
		return undefined
	}
	return { type, value: scopeValue }
}

/** Validate `source` against the union — our own token, but read without `as`. */
function parseSource(value: unknown): PermissionSource | null {
	if (value === 'grant' || value === 'bootstrap') {
		return value
	}
	if (typeof value === 'string' && value.startsWith('group:')) {
		return `group:${value.slice('group:'.length)}`
	}
	return null
}

function parsePermissionEntries(value: unknown): PermissionEntry[] | null {
	if (!Array.isArray(value)) {
		return null
	}
	const out: PermissionEntry[] = []
	for (const item of value) {
		const action = stringField(item, 'action')
		const scope = parseScope(prop(item, 'scope'))
		const source = parseSource(prop(item, 'source'))
		if (action === undefined || scope === undefined || source === null) {
			return null
		}
		out.push({ action, scope, source })
	}
	return out
}
