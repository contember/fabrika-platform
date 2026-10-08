/**
 * `createIam` — the single request-time entry point apps use instead of hand-rolling auth.
 *
 * Since [ADR-0022](../../../docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md) the PROXY is the only
 * thing that enforces: it matches the app's gates, resolves the credential, and injects a verified
 * access token as `PROXY_TOKEN_HEADER`. What is left for an app is small and fixed:
 *   - `authenticate(request)` — read that header and verify it LOCALLY against IAM's published JWKS
 *     (signature, `iss`, `aud`, `exp`), then build an `AuthContext`. The header is never trusted blindly.
 *   - `listPrincipals` — the app's people directory.
 *
 * There is NO gate evaluation here, no session→token exchange, and no cookie is ever written.
 *
 * There is also NO local mode. The SDK verifies IAM-issued tokens and nothing else, everywhere. Local
 * development runs the real stack (`bun run local:up`), where the proxy fronts each service and IAM
 * authenticates through its own `LOCAL_DEV_LOGIN` bypass — one dev bypass in the system, owned by the
 * service that owns identity.
 */

import { isOAuthResourceUri, PROXY_TOKEN_HEADER, type TokenAudienceProfile } from '@fabrika/auth-core'
import { buildAuthContext, IamClient } from './client'
import { readRequestId } from './request'
import type { AuthContext, IamBinding, ListPrincipalsFailure, PrincipalList } from './types'
import { TokenVerifier } from './verify'

// ── Public config surfaces ──────────────────────────────────────────────────────

/** The env `createIam` reads. An app's Worker `Env` satisfies it structurally (extra fields are fine). */
export interface IamEnv {
	/** The IAM service binding, or `HttpIamRpc` off Cloudflare. Typed by the contract — never the IAM Worker. */
	IAM?: IamBinding
	/** IAM origin — the token `iss` this SDK verifies against. Canonicalized once in `createIam`. */
	FABRIKA_IAM_ISSUER?: string
	/** Fallback app id when `opts.appId` is omitted. */
	FABRIKA_APP_ID?: string
}

/** Options for `createIam`. `appId` falls back to `env.FABRIKA_APP_ID`. */
export interface CreateIamOptions {
	/** The IAM app id (baked in so it can never be mistyped). Falls back to `env.FABRIKA_APP_ID`. */
	appId?: string
	/**
	 * Which tokens `authenticate` accepts. Defaults to the app's native tokens; a resource server
	 * passes `{ kind: 'resource', app, resource }` to accept OAuth tokens minted for that resource.
	 */
	tokenAudience?: TokenAudienceProfile
}

// ── Authentication result ────────────────────────────────────────────────────────

/** Why an authentication attempt produced no `AuthContext`. */
export type AuthFailureReason =
	/** No proxy-injected token on the request — a `public` gate, or nothing is in front of the app. */
	| 'no_token'
	/** A token was presented and did not verify: signature, `iss`, `aud`, `exp` or claim shape. */
	| 'invalid_token'
	/** The credential resolved to nobody — IAM says the principal is gone or disabled. */
	| 'unknown_principal'
	/** IAM could not be consulted at all. NOT a decided negative — an incident, and never a 401. */
	| 'unavailable'

/**
 * The outcome of `authenticate`. A DECIDED NEGATIVE (`invalid_token`, `unknown_principal`) is not the
 * same as "could not consult IAM" (`unavailable`, 503) — the same three-state rule `@fabrika/proxy`
 * implements. `authenticate` throws for neither case.
 */
export type AuthResult =
	| { ok: true; context: AuthContext }
	| { ok: false; reason: AuthFailureReason; status: 401 | 403 | 503 }

/** Failure half of `AuthResult` — what a caller maps to its own error envelope. */
export type AuthFailure = Extract<AuthResult, { ok: false }>

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

// ── Iam ──────────────────────────────────────────────────────────────────────────

/** Internal construction config — `createIam` assembles this; apps never build it directly. */
interface IamConfig {
	management: IamClient
	binding: IamBinding
	verifier: TokenVerifier
	appId: string
	tokenAudience: TokenAudienceProfile
}

/**
 * The request-time IAM surface. Build it with `createIam` (the only intended entry point — the
 * constructor takes an internal config). Bundles token verification and `listPrincipals`, both bound
 * to the env + app id resolved at construction.
 */
export class Iam {
	private readonly management: IamClient
	private readonly binding: IamBinding
	private readonly verifier: TokenVerifier
	private readonly appId: string
	private readonly tokenAudience: TokenAudienceProfile

	/** @internal — use `createIam`. */
	constructor(config: IamConfig) {
		this.management = config.management
		this.binding = config.binding
		this.verifier = config.verifier
		this.appId = config.appId
		this.tokenAudience = config.tokenAudience
	}

	// ── Management surface (delegated to the real client) ─────────────────────────

	listPrincipals(req: Request): Promise<PrincipalList | ListPrincipalsFailure> {
		return this.management.listPrincipals(req)
	}

	// ── Authentication ────────────────────────────────────────────────────────────

	/**
	 * Resolve the caller from the token the PROXY injected, verifying it locally against the JWKS.
	 * Never throws: an absent token, a token that does not verify, and an unreachable IAM are three
	 * distinct `ok: false` results.
	 */
	authenticate(request: Request): Promise<AuthResult> {
		const token = request.headers.get(PROXY_TOKEN_HEADER)?.trim() ?? ''
		if (token === '') {
			return Promise.resolve({ ok: false, reason: 'no_token', status: 401 })
		}
		return this.contextFor(token, readRequestId(request))
	}

	// ── Internals ─────────────────────────────────────────────────────────────────

	/** Verify one token and wrap its claims in the `permits`-backed `AuthContext`. */
	private async contextFor(token: string, requestId: string): Promise<AuthResult> {
		const verified = await this.verifier.verify(token, this.tokenAudience)
		if (!verified.ok) {
			return verified.reason === 'unavailable'
				? { ok: false, reason: 'unavailable', status: 503 }
				: { ok: false, reason: 'invalid_token', status: 401 }
		}
		return { ok: true, context: buildAuthContext(this.binding, token, verified.claims, requestId) }
	}
}

// ── createIam ──────────────────────────────────────────────────────────────────

/**
 * The single request-time entry point. Reads `env.IAM` and the IAM environment names, and returns an
 * `Iam` bound to them. Throws if the app id, the binding or the issuer is missing or unusable —
 * there is no mode in which any of the three is optional.
 */
export function createIam(env: IamEnv, opts: CreateIamOptions = {}): Iam {
	const appId = opts.appId ?? env.FABRIKA_APP_ID
	if (appId === undefined || appId === '') {
		throw new Error('createIam: app id is required — pass opts.appId or set env.FABRIKA_APP_ID')
	}

	const binding = env.IAM
	if (binding === undefined) {
		throw new Error('createIam: the IAM service binding is missing (env.IAM) — check the IAM ServiceReference.')
	}
	const issuer = canonicalIssuer(env.FABRIKA_IAM_ISSUER)
	const tokenAudience = opts.tokenAudience ?? { kind: 'app', app: appId }
	if (tokenAudience.app !== appId || (tokenAudience.kind === 'resource' && !isOAuthResourceUri(tokenAudience.resource))) {
		throw new Error('createIam: tokenAudience must name this app and, for a resource, a valid OAuth resource URI.')
	}
	return new Iam({
		management: new IamClient(binding, appId),
		binding,
		verifier: new TokenVerifier(binding, issuer, appId),
		appId,
		tokenAudience,
	})
}

/**
 * Canonicalize the issuer ONCE, at the boundary. It is a byte-exact contract — it is the token's `iss`,
 * and jose compares it verbatim — so `https://iam.test/` and `https://iam.test` must not be two
 * different issuers depending on which call site happened to trim.
 */
function canonicalIssuer(raw: string | undefined): string {
	if (raw === undefined || raw.trim() === '') {
		throw new Error('createIam: FABRIKA_IAM_ISSUER is missing — it is the issuer every token is verified against.')
	}
	let url: URL
	try {
		url = new URL(raw.trim())
	} catch {
		throw new Error('createIam: FABRIKA_IAM_ISSUER is not an absolute URL.')
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new Error('createIam: FABRIKA_IAM_ISSUER must be an http(s) origin.')
	}
	return url.origin
}
