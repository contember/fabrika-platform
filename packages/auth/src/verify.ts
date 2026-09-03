/**
 * Local access-token verification — the only thing this SDK still does with a credential.
 *
 * Since [ADR-0007](../../../docs/decisions/0007-proxy-based-auth-enforcement.md) the PROXY is the only
 * enforcement point: it matches the app's gates, resolves the credential, and injects the verified
 * token as `PROXY_TOKEN_HEADER`. The app must NOT trust that header blindly, so every token is
 * re-verified here against IAM's published JWKS — signature, `iss`, `aud`, `exp` — before it can
 * become an `AuthContext`.
 *
 * The verification itself is `@fabrika/jwks`, shared byte-for-byte with the proxy's enforcement path.
 * What this file owns is the SDK's construction shape: the audience is fixed at construction, and the
 * key set plus the unknown-`kid` cooldown are cached PER BINDING in a module-level WeakMap rather than
 * per instance — `@fabrika/app` calls its `middleware(env)` factory on every request, so an SDK object
 * built there is per-request while the binding lives for the isolate/process.
 */

import type { IamRpc } from '@fabrika/auth-core'
import { createJwksCache, type JwksCache, TokenVerifier as JwksVerifier, type VerifyResult } from '@fabrika/jwks'

export type { VerifyResult }

/** Key set + cooldown cached per binding, so they survive the per-request SDK objects built over them. */
const jwksCache = new WeakMap<IamRpc, JwksCache>()

function cacheFor(binding: IamRpc): JwksCache {
	let cache = jwksCache.get(binding)
	if (cache === undefined) {
		cache = createJwksCache()
		jwksCache.set(binding, cache)
	}
	return cache
}

/** Verifies tokens for ONE (binding, issuer, audience) triple. Cheap to construct; the cache is shared. */
export class TokenVerifier {
	private readonly inner: JwksVerifier

	constructor(
		binding: IamRpc,
		issuer: string,
		private readonly audience: string,
		now: () => number = () => Math.floor(Date.now() / 1000),
	) {
		this.inner = new JwksVerifier({ getJwks: () => binding.getJwks(), issuer, now, cache: cacheFor(binding) })
	}

	verify(token: string): Promise<VerifyResult> {
		return this.inner.verify(token, this.audience)
	}
}
