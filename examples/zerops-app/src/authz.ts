// Reading the token the PROXY injected, and authorizing against it — defence in depth, not the gate.
//
// ── The division of labour ────────────────────────────────────────────────────────────────────────
//
// The proxy already decided whether this request may reach the app at all: it evaluated the app's gates
// (`fabrika.gates.ts`), exchanged the session or the `px_` key with IAM, verified the resulting token,
// and forwarded the request with that token in a header. A request that failed any of that never got
// here — the app has no public route.
//
// So what is left for the app is the check the proxy CANNOT make: not "may this caller in", but "may
// this caller do THIS, to THAT object". A gate is per-path; `notes.delete` on workspace `acme` is
// per-object, and only the app knows which workspace a given note belongs to.
//
// ── Why the signature is verified again anyway ────────────────────────────────────────────────────
//
// Because trusting a header means trusting that nothing can ever reach this port except the proxy, and
// that is a network property, not a cryptographic one. Verifying is cheap — the JWKS is fetched once and
// cached, so the warm path is a local ECDSA check with no network call — and it turns "the proxy is the
// only route in" from an assumption into a belt on top of braces.
//
// The three checks that matter, all enforced by `jwtVerify` + `parseAccessClaims`:
//   - the signature is IAM's (JWKS, ES256);
//   - `iss` is the IAM origin this app was configured with;
//   - `aud` is THIS app — a token minted for another app is rejected, which is what stops a token
//     leaked from app A being replayed against app B.

import { type AccessTokenClaims, parseAccessClaims, permits, type Scope, scopedValues } from '@fabrika/auth-core'
import { createRemoteJWKSet, jwtVerify } from 'jose'

/**
 * The header the proxy copies the verified token into — the portable successor to
 * `Cf-Access-Jwt-Assertion`.
 *
 * Declared here rather than imported: an app must not depend on `@fabrika/proxy`, which is a deployed
 * service and not a library for apps. The constant is duplicated on purpose and the duplication is
 * CHECKED — `deploy/zerops/__tests__/example-app.test.ts` asserts this equals the proxy's own
 * `PROXY_TOKEN_HEADER`, so a rename fails a test instead of silently un-authenticating every request.
 * The real fix is to hoist the name into `@fabrika/auth-core`, which both sides may depend on.
 */
export const PROXY_TOKEN_HEADER = 'X-Fabrika-Token'

/** The authenticated caller, as this app sees them. */
export interface Caller {
	/** Principal id (a user or a service), or the issuing credential's id for an anonymous token. */
	subject: string
	/** Audit actor label — may be null for an anonymous credential such as a share link. */
	label: string | null
	/** `true` when the request arrived on a `public` gate: no token, no permissions, `can()` is always false. */
	anonymous: boolean
	/** May this caller perform `action`, optionally within `scope`? */
	can(action: string, scope?: Scope): boolean
	/** The scope values of `dimension` this caller may perform `action` in; `null` means "all of them". */
	scopedTo(action: string, dimension: string): string[] | null
}

/** The anonymous caller — what a `public`-gated path gets. Deliberately not `null`: `can()` still works. */
export const ANONYMOUS: Caller = {
	subject: 'anonymous',
	label: null,
	anonymous: true,
	can: () => false,
	scopedTo: () => [],
}

const fromClaims = (claims: AccessTokenClaims): Caller => ({
	subject: claims.sub,
	label: claims.label,
	anonymous: false,
	// Authorization is `permits` over the claims the token already carries: no round-trip to IAM, and
	// identical logic to the one IAM used to build them, because both call the same function.
	can: (action, scope) => permits(claims.perms, action, scope),
	scopedTo: (action, dimension) => scopedValues(claims.perms, action, dimension),
})

export interface TokenReaderOptions {
	/** IAM's public origin — the token issuer and the JWKS base. */
	issuer: string
	/** This app's id. A token whose `aud` is anything else is rejected. */
	appId: string
	/** Overridable so a test can supply a local key set instead of fetching one. */
	keys?: Parameters<typeof jwtVerify>[1]
}

/**
 * Build the per-request token reader. The JWKS handle is created ONCE and closed over: `jose`'s remote
 * key set caches and refetches on a `kid` miss, so a reader built per request would fetch the key set on
 * every request.
 */
export const createTokenReader = (options: TokenReaderOptions): (request: Request) => Promise<Caller | null> => {
	const keys = options.keys ?? createRemoteJWKSet(new URL('/.well-known/jwks.json', options.issuer))
	return async (request: Request): Promise<Caller | null> => {
		const token = request.headers.get(PROXY_TOKEN_HEADER)
		if (token === null || token === '') {
			return null
		}
		try {
			const { payload } = await jwtVerify(token, keys, { issuer: options.issuer, audience: options.appId })
			const claims = parseAccessClaims(payload)
			return claims === null ? null : fromClaims(claims)
		} catch {
			// Any verification failure is the same answer — unauthenticated. Never echo the token, and
			// never distinguish "expired" from "forged" to the caller.
			return null
		}
	}
}
