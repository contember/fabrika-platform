// @fabrika/jwks — the single JWKS-backed access-token verifier.
//
// Two packages verify the proxy-minted token against IAM's key set: `@fabrika/auth` (the app SDK)
// and `@fabrika/proxy-core` (the enforcement point). Neither may import the other — the SDK must not
// pull in enforcement code, the proxy must not pull in the SDK — and `@fabrika/auth-core` cannot host
// the code because it is deliberately dependency-free (no `jose`) for its browser-side consumers.
// So the implementation lives here and both wrap it with their own construction shape.

export { createJwksCache, JWKS_REFETCH_COOLDOWN_SECONDS, JWKS_TTL_SECONDS, TokenVerifier } from './verifier'
export type { JwksCache, TokenVerifierOptions, VerifyResult } from './verifier'
