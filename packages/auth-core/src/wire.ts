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
