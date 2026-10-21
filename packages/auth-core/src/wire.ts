import { sha256Hex } from './sha256'

/** Header carrying the proxy-verified access token to the upstream app. */
export const PROXY_TOKEN_HEADER = 'X-Fabrika-Token'

/**
 * Header carrying the CLIENT COORDINATE the enforcement point observed — the only address an inner
 * hop may key an abuse limit on.
 *
 * Owned exactly like `PROXY_TOKEN_HEADER`: the edge deletes a caller-supplied one and writes its own,
 * so an upstream reading it is reading the edge and never the caller. It is deliberately NOT
 * `X-Forwarded-For` — that name means "whatever the chain appended", and a value whose
 * trustworthiness depends on where you are standing is exactly the key backlog 21 and 49 twice
 * refused to build on ([sprint](../../../docs/archive/sprint-2026-08-05-auth-track-closeout.md)).
 *
 * Where a composition cannot observe the client the header is simply ABSENT, and the upstream then
 * has no per-client bucket — today's behaviour — rather than a spoofable one.
 */
export const CLIENT_ADDRESS_HEADER = 'X-Fabrika-Client-Ip'

/**
 * The other names a client address travels under, deleted at ingress so `CLIENT_ADDRESS_HEADER` is the
 * only one an upstream can read.
 *
 * Two reasons, and both matter. `X-Forwarded-For` is caller-writable on BOTH compositions — Caddy
 * keeps a client-supplied prefix once the peer is trusted, and Cloudflare appends to whatever the
 * caller sent — so a downstream reading it reads the caller. `CF-Connecting-IP` is genuinely
 * trustworthy on Cloudflare's edge and a caller's invention anywhere else, which is worse: an app that
 * reads it works on one cloud and silently keys on a forgery on the other. Deleting both leaves one
 * header with one meaning everywhere, supplied only by the enforcement point.
 */
export const UNTRUSTED_FORWARD_HEADERS: readonly string[] = ['X-Forwarded-For', 'CF-Connecting-IP']

/**
 * Header carrying the endpoint the proxy selected and the digest of the rules it applied, `<id>@<digest>`
 * (`formatEndpointHeader`). Set by the proxy on every allowed request to a contract application, after the strip of
 * a client's own; the application serves only that endpoint and answers 503 when its digest differs.
 */
export const ENDPOINT_HEADER = 'X-Fabrika-Endpoint'

/**
 * Header carrying the single-use delegation grant the proxy obtained from IAM for a membership or scope-creating
 * endpoint (ADR-0022 rule 6). The framework forwards it to IAM; nothing else reads it.
 */
export const DELEGATION_HEADER = 'X-Fabrika-Delegation'

/**
 * Header carrying the proxy secret of one application environment (ADR-0022 rule 5), on Zerops only: a namespace is
 * one private network, so the application refuses a request that does not prove it came through the proxy. On
 * Cloudflare the service binding is the authenticated hop and this header is never set.
 */
export const PROXY_SECRET_HEADER = 'X-Fabrika-Proxy-Secret'

/** The application's framework variable holding the secret its proxy sends in `PROXY_SECRET_HEADER`. */
export const FABRIKA_PROXY_SECRET = 'FABRIKA_PROXY_SECRET'

/**
 * The proxy service's variable holding the secret of application environment `id` (`<app>@<env>`). One proxy fronts
 * every application of a namespace, so each secret needs its own name; an environment name may hold any character, so
 * the name carries a digest of the id rather than the id.
 */
export function proxySecretVariable(id: string): string {
	return `${FABRIKA_PROXY_SECRET}_${sha256Hex(id).slice(0, 32).toUpperCase()}`
}

/**
 * The variable holding the secret the platform proxy sends IAM's installation entry in `PROXY_SECRET_HEADER`. The proxy
 * and IAM hold it under this one name. It proves only who wrote IAM's client-address and request-id headers.
 */
export const IAM_PROXY_SECRET_VARIABLE = 'FABRIKA_INSTALLATION_PROXY_SECRET_IAM'

/**
 * Every `X-Fabrika-*` name a proxy hop carries to an application. Caddy's first step and the Cloudflare proxy Worker
 * delete each of them from the client's request before anything else, then set only what the decision asserts. A new
 * header the proxy sets joins this list in the same change. The Operations upload headers are not hop headers: a
 * client sends them to Operations through the platform proxy, so the proxy must let them pass.
 */
export const FABRIKA_HOP_HEADERS: readonly string[] = [
	PROXY_TOKEN_HEADER,
	CLIENT_ADDRESS_HEADER,
	ENDPOINT_HEADER,
	DELEGATION_HEADER,
	PROXY_SECRET_HEADER,
]
