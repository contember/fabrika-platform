/**
 * The wire names the proxy and its Caddy config agree on. Both sides are generated from this file
 * (`caddy.ts` reads the same constants the service does), so a rename cannot desynchronise them.
 */

export { CLIENT_ADDRESS_HEADER, PROXY_TOKEN_HEADER, UNTRUSTED_FORWARD_HEADERS } from '@fabrika/auth-core'

// ── What Caddy's `forward_auth` sends us ───────────────────────────────────────
//
// `forward_auth` rewrites the subrequest to `GET <uri>`, so the ORIGINAL method and URI arrive only
// in these headers. `reverse_proxy` adds the other three X-Forwarded-* itself. Everything the gate
// decision depends on comes from here — never from the `/verify` request's own method/path.

export const FORWARDED_METHOD_HEADER = 'X-Forwarded-Method'
export const FORWARDED_URI_HEADER = 'X-Forwarded-Uri'
export const FORWARDED_HOST_HEADER = 'X-Forwarded-Host'
export const FORWARDED_PROTO_HEADER = 'X-Forwarded-Proto'

/** Correlation id, when the edge supplies one; otherwise the proxy generates a UUIDv7. */
export const REQUEST_ID_HEADER = 'X-Request-Id'

/** The auth service's decision endpoint (Caddy's `uri` subdirective). */
export const DEFAULT_VERIFY_PATH = '/verify'
/** Liveness endpoint on the auth service itself — never routed publicly. */
export const DEFAULT_HEALTH_PATH = '/healthz'
/**
 * Query parameter the generated Caddy route pins the app id with. Explicit beats host-sniffing: the
 * route already knows which app it fronts, so the auth service never has to infer it.
 */
export const APP_QUERY_PARAM = 'app'

/**
 * Query parameter IAM's `/auth/login` takes the return URL in (ADR-0021). The proxy writes it on the
 * login bounce and redacts it out of the access log, where it would re-emit — percent-encoded — a
 * credential that was just stripped from the logged URI.
 */
export const LOGIN_REDIRECT_PARAM = 'redirect'

/** How long a fetched JWKS is reused before a refetch (a kid rotation also forces one on demand). */
export const JWKS_TTL_SECONDS = 600
/**
 * Minimum gap between two unknown-`kid` refetches. Bounds how often a token nobody can verify may
 * cost an IAM round trip — the token is denied either way, and a real rotation is picked up within it.
 */
export const JWKS_REFETCH_COOLDOWN_SECONDS = 30

/** Default IAM request timeout. A hung IAM must deny, not hang every request behind it. */
export const DEFAULT_IAM_TIMEOUT_MS = 5_000
