// @fabrika/proxy-core — the auth enforcement decision, as a library.
//
// ADR-0022 makes the proxy the ONLY enforcement point, and there are two of them: a Bun service
// answering Caddy's `forward_auth` subrequest on Zerops, and the Cloudflare proxy Worker calling the
// same code in-process. This package is what they share — take a forwarded request, decide, and mint
// or refuse. It is runtime-neutral by construction: no Caddy, no filesystem, no process.
//
// The deployment that fronts it on Zerops — the Caddy configuration and the compiled binary — is
// `@fabrika/proxy`, which is private because it is an artifact rather than an API. The manifest wire
// contract and its strict parser are `@fabrika/proxy-contract`; the gate matcher and the token claims
// are `@fabrika/auth-core`.

export { Authorizer } from './authorize'
export type { AuthorizerOptions, Decision, DenyReason, ForwardedRequest, ResolvedApp } from './authorize'
export { cacheKey, MemoryTokenCache } from './cache'
export type { CachedToken, TokenCache } from './cache'
export {
	APP_QUERY_PARAM,
	CLIENT_ADDRESS_HEADER,
	DEFAULT_HEALTH_PATH,
	DEFAULT_IAM_TIMEOUT_MS,
	DEFAULT_VERIFY_PATH,
	FORWARDED_HOST_HEADER,
	FORWARDED_METHOD_HEADER,
	FORWARDED_PROTO_HEADER,
	FORWARDED_URI_HEADER,
	JWKS_TTL_SECONDS,
	LOGIN_REDIRECT_PARAM,
	PROXY_TOKEN_HEADER,
	REQUEST_ID_HEADER,
	UNTRUSTED_FORWARD_HEADERS,
} from './constants'
export { applicableGates, compileGates, readBearer, readCookie, readServiceCredential } from './gates'
export type { CompiledGate } from './gates'
export { stripFabrikaCookies } from './handoff'
export { HttpIamGateway, IamUnavailableError } from './iam'
export type { HttpIamGatewayOptions, IamGateway } from './iam'
export { consoleLogger, redactPath, redactUrl, silentLogger } from './log'
export type { LogFields, LogValue, ProxyLogger } from './log'
export { createVerifyService } from './service'
export type { VerifyService, VerifyServiceConfig } from './service'
export { TokenVerifier } from './verifier'
export type { VerifyResult } from './verifier'
