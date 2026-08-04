/**
 * `createIam` — the single request-time entry point apps use instead of hand-rolling auth.
 *
 * Since [ADR-0007](../../../docs/decisions/0007-proxy-based-auth-enforcement.md) the PROXY is the only
 * thing that enforces: it matches the app's gates, resolves the credential, and injects a verified
 * access token as `PROXY_TOKEN_HEADER`. What is left for an app is small and fixed:
 *   - `authenticate(request)` — read that header and verify it LOCALLY against IAM's published JWKS
 *     (signature, `iss`, `aud`, `exp`), then build an `AuthContext`. The header is never trusted blindly.
 *   - `redeemKey(token)` — redeem a share-link capability OFF the gate path. Those requests arrive
 *     through a `public`/`service` gate and the app redeems the capability itself; there is no proxy
 *     equivalent by design.
 *   - the MANAGEMENT surface (`listPrincipals` / `issueKey` / `issueJwt` / `revokeKey`).
 *   - `devLoginHandler()` — the local persona switch.
 *
 * There is NO gate evaluation here, no session→token exchange, and no cookie is ever written.
 *
 * Dev-aware: with `DEV=true` AND `ENVIRONMENT=local` the whole thing is backed by `FakeIamClient` plus
 * synthetic persona contexts (no IAM service, no SSO). Every other value of `DEV` uses the real binding,
 * and an unrecognised one throws rather than guessing.
 */

import {
	API_KEY_PREFIX,
	type IamRpc,
	type MintFromKeyResult,
	type PermissionEntry,
	permits,
	type PrincipalType,
	PROXY_TOKEN_HEADER,
	type Scope,
	scopedValues,
	TOKEN_REFRESH_SKEW_SECONDS,
} from '@fabrika/auth-core'
import { environmentAliases } from '@fabrika/platform'
import { buildAuthContext, IamClient } from './client'
import { FakeIamClient, type FakePersona } from './fake'
import { readRequestId } from './request'
import type {
	AuthContext,
	IssuedJwt,
	IssuedKey,
	IssueFailure,
	IssueJwtRequest,
	IssueKeyRequest,
	ListPrincipalsFailure,
	PrincipalIdentity,
	PrincipalList,
	RevokedKey,
	RevokeFailure,
} from './types'
import { TokenVerifier } from './verify'

// ── Public config surfaces ──────────────────────────────────────────────────────

/** The env `createIam` reads. An app's Worker `Env` satisfies it structurally (extra fields are fine). */
export interface IamEnv {
	/** The IAM service binding (off-local). Typed as the `IamRpc` contract — never the IAM Worker. */
	IAM?: IamRpc
	/** IAM origin — the token `iss` this SDK verifies against. Canonicalized once in `createIam`. */
	FABRIKA_IAM_URL?: string
	/** Deprecated issuer fallback. */
	PROPUSTKA_URL?: string
	/** Canonical fallback app id when `opts.appId` is omitted. */
	FABRIKA_APP_ID?: string
	/** Deprecated app id fallback. */
	PROPUSTKA_APP_ID?: string
	/** Deployment stage. The dev/fake path is REFUSED unless this is exactly `local`. */
	ENVIRONMENT?: string
	/**
	 * Dev flag. ONLY `true` / `'true'` / `'1'` select the fake client + persona path; `false` /
	 * `'false'` / `'0'` / `''` / absent are the real path. Any other value THROWS — see `devEnabled`.
	 */
	DEV?: string | boolean
}

/**
 * A dev persona — an identity plus its permission grants, evaluated by `makeDevContext` against the
 * real `permits`/`scopedValues` matchers so the dev path enforces scope EXACTLY like prod. Keyed by
 * email in `opts.devPersonas`. `permissions` carry no `source` (it is data, not a resolution origin).
 */
export interface PersonaSpec {
	id: string
	label: string
	/** 'user' or 'service'; any non-'service' value resolves to 'user'. */
	type: string
	permissions: Array<{ action: string; scope: Scope | null }>
}

/** Options for `createIam`. `appId` falls back to `env.FABRIKA_APP_ID`, then the legacy name. */
export interface CreateIamOptions {
	/** The IAM app id (baked in so it can never be mistyped). Falls back to the canonical env alias. */
	appId?: string
	/** Dev persona roster keyed by email — the local people directory + the synthetic-context source. */
	devPersonas?: Record<string, PersonaSpec>
	/** Persona used in dev when no `?__as=` / cookie selector is present (e.g. the admin). */
	devDefaultPersona?: string
	/** The cookie the dev persona-switch reads/writes. Default `propustka_dev_principal`. */
	devPersonaCookie?: string
	/** Optional request header that overrides the query/cookie dev persona selector. */
	devPersonaHeader?: string
}

// ── Authentication result ────────────────────────────────────────────────────────

/** Why an authentication attempt produced no `AuthContext`. */
export type AuthFailureReason =
	/** No proxy-injected token on the request — a `public` gate, or nothing is in front of the app. */
	| 'no_token'
	/** A token was presented and did not verify: signature, `iss`, `aud`, `exp` or claim shape. */
	| 'invalid_token'
	/** The credential resolved to nobody (an unknown dev persona, or IAM says the principal is gone). */
	| 'unknown_principal'
	/** IAM could not be consulted at all. NOT a decided negative — an incident, and never a 401. */
	| 'unavailable'

/**
 * The outcome of `authenticate` / `redeemKey`. A DECIDED NEGATIVE (`invalid_token`,
 * `unknown_principal`) is not the same as "could not consult IAM" (`unavailable`, 503) — the same
 * three-state rule `@fabrika/proxy` implements. Neither method throws for either case.
 */
export type AuthResult =
	| { ok: true; context: AuthContext }
	| { ok: false; reason: AuthFailureReason; status: 401 | 403 | 503 }

/** Failure half of `AuthResult` — what a caller maps to its own error envelope. */
export type AuthFailure = Extract<AuthResult, { ok: false }>

// ── makeDevContext + persona helpers ─────────────────────────────────────────────

/** Narrow a `PersonaSpec.type` (a plain string) to a `PrincipalType`; anything but 'service' is 'user'. */
function principalType(type: string): PrincipalType {
	return type === 'service' ? 'service' : 'user'
}

/** A persona's grants as `PermissionEntry[]` (stamped `source: 'grant'`) for the `permits` matchers. */
function personaEntries(persona: PersonaSpec): PermissionEntry[] {
	return persona.permissions.map((grant) => ({ action: grant.action, scope: grant.scope, source: 'grant' }))
}

/**
 * Build a synthetic `AuthContext` for a dev persona. `can`/`scopedTo` evaluate against the persona's
 * grants using core's `permits`/`scopedValues` — the SAME matchers the real (token-backed) context
 * uses, so dev enforces scope identically to prod. `audit` is a no-op (no IAM service locally).
 */
export function makeDevContext(persona: PersonaSpec): AuthContext {
	const entries = personaEntries(persona)
	const principal: PrincipalIdentity = { id: persona.id, type: principalType(persona.type), label: persona.label }
	return {
		ok: true,
		principal,
		can: (action, scope) => permits(entries, action, scope),
		scopedTo: (action, dimension) => scopedValues(entries, action, dimension),
		audit: () => Promise.resolve(),
	}
}

/** Map the public `PersonaSpec` roster to the `FakeIamClient`'s `FakePersona` shape (for `listPrincipals`). */
function toFakePersonas(personas: Record<string, PersonaSpec> | undefined): Record<string, FakePersona> | undefined {
	if (personas === undefined) {
		return undefined
	}
	const out: Record<string, FakePersona> = {}
	for (const [email, persona] of Object.entries(personas)) {
		out[email] = { id: persona.id, label: persona.label, type: principalType(persona.type), permissions: personaEntries(persona) }
	}
	return out
}

// ── Synthetic contexts ───────────────────────────────────────────────────────────

/**
 * The ANONYMOUS context — no principal, NO permissions (`can` → false, `scopedTo` → [] = none),
 * `audit` a no-op. What an app sets on a request the proxy admitted through a `public` gate: there is
 * no token to verify, and nothing about the caller is known. An RPC procedure's `.require` on such a
 * request would (correctly) 403.
 */
export function anonymousContext(): AuthContext {
	return {
		ok: true,
		principal: null,
		can: () => false,
		scopedTo: () => [],
		audit: () => Promise.resolve(),
	}
}

/** An OPEN capability context for dev — a present share token grants everything (the local gate is open). */
function openCapabilityContext(): AuthContext {
	return {
		ok: true,
		principal: null,
		can: () => true,
		scopedTo: () => null,
		audit: () => Promise.resolve(),
	}
}

// ── Small helpers ────────────────────────────────────────────────────────────────

/** URL-decode a value, falling back to the raw value on malformed input (never throws). */
function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

/** Read a single cookie value out of a raw Cookie header. Null when absent. */
function readCookie(header: string | null, name: string): string | null {
	if (!header) {
		return null
	}
	for (const part of header.split(';')) {
		const eq = part.indexOf('=')
		if (eq !== -1 && part.slice(0, eq).trim() === name) {
			return part.slice(eq + 1).trim()
		}
	}
	return null
}

/** Hex SHA-256 — the key-cache index, so no plaintext credential is ever held in memory as a map key. */
async function digest(value: string): Promise<string> {
	const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
	let hex = ''
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, '0')
	}
	return hex
}

/**
 * Per-binding cache of the access token minted from a `px_` share credential, keyed by the credential's
 * SHA-256 digest and bounded — a share link redeemed on every request would otherwise pin an unbounded
 * number of plaintext credentials for the process lifetime.
 */
const KEY_CACHE_MAX_ENTRIES = 256
const keyTokenCache = new WeakMap<IamRpc, Map<string, { token: string; expiresAt: number }>>()

function keyCacheFor(binding: IamRpc): Map<string, { token: string; expiresAt: number }> {
	let cache = keyTokenCache.get(binding)
	if (cache === undefined) {
		cache = new Map()
		keyTokenCache.set(binding, cache)
	}
	return cache
}

/** Insert with a hard bound, evicting the oldest entry (Map preserves insertion order). */
function rememberKey(cache: Map<string, { token: string; expiresAt: number }>, key: string, entry: { token: string; expiresAt: number }): void {
	if (!cache.has(key) && cache.size >= KEY_CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next()
		if (oldest.done !== true) {
			cache.delete(oldest.value)
		}
	}
	cache.set(key, entry)
}

// ── Iam ──────────────────────────────────────────────────────────────────────────

/** Mode-specific deps: dev needs nothing; off-local needs the binding + a verifier (so no `!` later). */
type OffLocalMode = { dev: false; binding: IamRpc; verifier: TokenVerifier }
type IamMode = { dev: true } | OffLocalMode

/** Internal construction config — `createIam` assembles this; apps never build it directly. */
interface IamConfig {
	management: IamClient | FakeIamClient
	mode: IamMode
	appId: string
	devPersonas: Record<string, PersonaSpec> | undefined
	devDefaultPersona: string | undefined
	devPersonaCookie: string
	devPersonaHeader: string | undefined
}

/**
 * The request-time IAM surface. Build it with `createIam` (the only intended entry point — the
 * constructor takes an internal config). Bundles the management methods, token verification, share-link
 * redemption, and the dev login handler — all bound to the env + app id resolved at construction.
 */
export class Iam {
	private readonly management: IamClient | FakeIamClient
	private readonly mode: IamMode
	private readonly appId: string
	private readonly devPersonas: Record<string, PersonaSpec> | undefined
	private readonly devDefaultPersona: string | undefined
	private readonly devPersonaCookie: string
	private readonly devPersonaHeader: string | undefined

	/** @internal — use `createIam`. */
	constructor(config: IamConfig) {
		this.management = config.management
		this.mode = config.mode
		this.appId = config.appId
		this.devPersonas = config.devPersonas
		this.devDefaultPersona = config.devDefaultPersona
		this.devPersonaCookie = config.devPersonaCookie
		this.devPersonaHeader = config.devPersonaHeader
	}

	// ── Management surface (delegated to the real / fake client) ──────────────────

	listPrincipals(req: Request): Promise<PrincipalList | ListPrincipalsFailure> {
		return this.management.listPrincipals(req)
	}

	issueKey(req: Request, input: IssueKeyRequest): Promise<IssuedKey | IssueFailure> {
		return this.management.issueKey(req, input)
	}

	issueJwt(req: Request, input: IssueJwtRequest): Promise<IssuedJwt | IssueFailure> {
		return this.management.issueJwt(req, input)
	}

	revokeKey(req: Request, id: string): Promise<RevokedKey | RevokeFailure> {
		return this.management.revokeKey(req, id)
	}

	// ── Authentication ────────────────────────────────────────────────────────────

	/**
	 * Resolve the caller from the token the PROXY injected, verifying it locally against the JWKS. In
	 * dev the persona selector (`?__as=` / the configured header / the cookie / the default) stands in
	 * for it. Never throws: an absent token, a token that does not verify, and an unreachable IAM are
	 * three distinct `ok: false` results.
	 */
	authenticate(request: Request): Promise<AuthResult> {
		const mode = this.mode
		if (mode.dev) {
			return Promise.resolve(this.resolveDevPersona(request))
		}
		const token = request.headers.get(PROXY_TOKEN_HEADER)?.trim() ?? ''
		if (token === '') {
			return Promise.resolve({ ok: false, reason: 'no_token', status: 401 })
		}
		return this.contextFor(mode, token, readRequestId(request))
	}

	/**
	 * Redeem an opaque `px_` share credential (or a passthrough JWT) into an `AuthContext` OFF the gate
	 * path — the seam a capability/share link uses, where the token rides a query param or a cookie
	 * rather than satisfying a gate. A `px_` key is exchanged once via `mintFromKey` and cached per
	 * binding; anything else is verified locally with no IAM call. In dev a present token grants an
	 * open context (the local share gate is open). Never throws — map a failure to a 404 so the surface
	 * does not reveal whether the resource exists.
	 */
	async redeemKey(token: string): Promise<AuthResult> {
		const mode = this.mode
		if (mode.dev) {
			return { ok: true, context: openCapabilityContext() }
		}
		const requestId = crypto.randomUUID()
		if (!token.startsWith(API_KEY_PREFIX)) {
			// A passthrough JWT — verify locally, no IAM call.
			return await this.contextFor(mode, token, requestId)
		}

		const cache = keyCacheFor(mode.binding)
		const index = await digest(token)
		const now = Math.floor(Date.now() / 1000)
		const cached = cache.get(index)
		if (cached !== undefined && cached.expiresAt - now > TOKEN_REFRESH_SKEW_SECONDS) {
			const result = await this.contextFor(mode, cached.token, requestId)
			if (result.ok || result.reason === 'unavailable') {
				// Unverifiable because IAM is down is NOT evidence against the cached token — say so and stop.
				return result
			}
			// A cached token that no longer verifies (rotated key, revoked issuer) is dropped, not trusted.
			cache.delete(index)
		}

		let minted: MintFromKeyResult
		try {
			minted = await mode.binding.mintFromKey({ app: this.appId, key: token, requestId })
		} catch {
			// A transport failure is "we could not consult IAM", never a decided negative. Never log the
			// error object: it can carry the credential or a request URL.
			return { ok: false, reason: 'unavailable', status: 503 }
		}
		if (!minted.ok) {
			return minted.reason === 'invalid_key'
				? { ok: false, reason: 'invalid_token', status: 401 }
				: { ok: false, reason: 'unknown_principal', status: 403 }
		}
		const result = await this.contextFor(mode, minted.token, requestId)
		if (result.ok) {
			rememberKey(cache, index, { token: minted.token, expiresAt: minted.expiresAt })
		}
		return result
	}

	/**
	 * The standard dev persona-switch handler: set the persona cookie from `?as=<email>` and 302 to `/`,
	 * so apps drop their bespoke `/__dev/login`. Gate it behind dev in your router (it always sets the
	 * cookie; it does not check the mode itself).
	 */
	devLoginHandler(): (request: Request) => Response {
		const cookieName = this.devPersonaCookie
		return (request) => {
			const as = new URL(request.url).searchParams.get('as') ?? ''
			const headers = new Headers({ location: '/' })
			headers.append('set-cookie', `${cookieName}=${encodeURIComponent(as)}; Path=/; SameSite=Lax`)
			return new Response(null, { status: 302, headers })
		}
	}

	// ── Internals ─────────────────────────────────────────────────────────────────

	/** Verify one token and wrap its claims in the `permits`-backed `AuthContext`. */
	private async contextFor(mode: OffLocalMode, token: string, requestId: string): Promise<AuthResult> {
		const verified = await mode.verifier.verify(token)
		if (!verified.ok) {
			return verified.reason === 'unavailable'
				? { ok: false, reason: 'unavailable', status: 503 }
				: { ok: false, reason: 'invalid_token', status: 401 }
		}
		return { ok: true, context: buildAuthContext(mode.binding, this.appId, verified.claims, requestId) }
	}

	/** Resolve a dev persona to an `AuthResult` (so success/failure flow through the same shape). */
	private resolveDevPersona(request: Request): AuthResult {
		// `__as` is decoded by URLSearchParams; the cookie was URL-encoded by `devLoginHandler`, so decode it.
		const cookieSelector = readCookie(request.headers.get('Cookie'), this.devPersonaCookie)
		const headerSelector = this.devPersonaHeader === undefined ? null : request.headers.get(this.devPersonaHeader)
		const selector = headerSelector ?? new URL(request.url).searchParams.get('__as') ?? (cookieSelector === null ? null : safeDecode(cookieSelector))
			?? this.devDefaultPersona
			?? null
		if (selector === null) {
			return { ok: false, reason: 'no_token', status: 401 }
		}
		const persona = this.devPersonas?.[selector]
		if (persona === undefined) {
			return { ok: false, reason: 'unknown_principal', status: 403 }
		}
		return { ok: true, context: makeDevContext(persona) }
	}
}

// ── createIam ──────────────────────────────────────────────────────────────────

/**
 * The single request-time entry point. Reads `env.IAM`, canonical-first IAM environment aliases,
 * `env.ENVIRONMENT` and `env.DEV`, and returns an `Iam` backed by the fake (dev) or the real binding.
 * Throws if the app id is missing, if `DEV` is unreadable or selected outside `local`, or — off-local
 * — if the binding or the issuer is missing or unusable.
 */
export function createIam(env: IamEnv, opts: CreateIamOptions = {}): Iam {
	const appId = opts.appId
		?? environmentAliases.read(env, { canonical: 'FABRIKA_APP_ID', legacy: 'PROPUSTKA_APP_ID' })
	if (appId === undefined || appId === '') {
		throw new Error('createIam: app id is required — pass opts.appId or set env.FABRIKA_APP_ID')
	}
	const devPersonaCookie = opts.devPersonaCookie ?? 'propustka_dev_principal'
	const devPersonaHeader = opts.devPersonaHeader

	if (devEnabled(env)) {
		warnFakeClientOnce()
		const fakePersonas = toFakePersonas(opts.devPersonas)
		const management = new FakeIamClient(fakePersonas === undefined ? {} : { personas: fakePersonas })
		return new Iam({
			management,
			mode: { dev: true },
			appId,
			devPersonas: opts.devPersonas,
			devDefaultPersona: opts.devDefaultPersona,
			devPersonaCookie,
			devPersonaHeader,
		})
	}

	const binding = env.IAM
	if (binding === undefined) {
		throw new Error('createIam: the IAM service binding is missing off-local (env.IAM) — check the IAM ServiceReference.')
	}
	const issuer = canonicalIssuer(environmentAliases.read(env, { canonical: 'FABRIKA_IAM_URL', legacy: 'PROPUSTKA_URL' }))
	const management = new IamClient(binding, appId)
	return new Iam({
		management,
		mode: { dev: false, binding, verifier: new TokenVerifier(binding, issuer, appId) },
		appId,
		devPersonas: opts.devPersonas,
		devDefaultPersona: opts.devDefaultPersona,
		devPersonaCookie,
		devPersonaHeader,
	})
}

/**
 * Parse `DEV` STRICTLY, then refuse it outside `ENVIRONMENT=local`.
 *
 * Both first-party consumers give their default dev persona a global-admin grant, so a `DEV` value the
 * old truthiness check misread (`'false'`, `'0'`, `'no'`) turned every unauthenticated request into a
 * global admin, silently. Only `true` / `'true'` / `'1'` select the fake; `false` / `'false'` / `'0'` /
 * `''` / absent are the real path; anything else is a configuration error and stops the boot. The
 * `ENVIRONMENT` gate mirrors `@fabrika/iam`'s `getSigner`, which likewise refuses an ephemeral key
 * off-local.
 */
function devEnabled(env: IamEnv): boolean {
	const raw = env.DEV
	if (raw === undefined || raw === false || raw === '' || raw === 'false' || raw === '0') {
		return false
	}
	if (raw !== true && raw !== 'true' && raw !== '1') {
		throw new Error("createIam: DEV must be one of 'true', '1', 'false', '0' or empty — refusing to guess")
	}
	if (env.ENVIRONMENT !== 'local') {
		throw new Error('createIam: DEV selects FakeIamClient and synthetic personas — refused unless ENVIRONMENT=local')
	}
	return true
}

let warnedFakeClient = false

/** Say it once per process, loudly: nothing is being verified and the personas are synthetic. */
function warnFakeClientOnce(): void {
	if (warnedFakeClient) {
		return
	}
	warnedFakeClient = true
	console.warn('@fabrika/auth: DEV is on — FakeIamClient and synthetic dev personas are active; no token is verified')
}

/**
 * Canonicalize the issuer ONCE, at the boundary. It is a byte-exact contract — it is the token's `iss`,
 * and jose compares it verbatim — so `https://iam.test/` and `https://iam.test` must not be two
 * different issuers depending on which call site happened to trim.
 */
function canonicalIssuer(raw: string | undefined): string {
	if (raw === undefined || raw.trim() === '') {
		throw new Error('createIam: FABRIKA_IAM_URL is missing off-local — it is the issuer every token is verified against.')
	}
	let url: URL
	try {
		url = new URL(raw.trim())
	} catch {
		throw new Error('createIam: FABRIKA_IAM_URL is not an absolute URL.')
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error('createIam: FABRIKA_IAM_URL must be an http(s) origin.')
	}
	return url.origin
}
