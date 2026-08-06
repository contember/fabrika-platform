// @fabrika/proxy — the auth enforcement proxy: the `forward_auth` decision service plus the Caddy
// configuration that fronts it.
//
// ADR-0007 makes the proxy the ONLY publicly routed thing in an environment project, so an app that
// forgets to check auth is still unreachable. ADR-0008 splits the job: Caddy owns HTTP correctness,
// this package owns the auth decision — once, in TypeScript, for both Cloudflare and Zerops.

export { Authorizer } from './authorize'
export type { AuthorizerOptions, Decision, DenyReason, ForwardedRequest, ResolvedApp } from './authorize'
export { cacheKey, MemoryTokenCache } from './cache'
export type { CachedToken, TokenCache } from './cache'
export { buildCaddyConfig, CaddyConfigError, uriRedactionPattern } from './caddy'
export type {
	CaddyBuildOptions,
	CaddyConfig,
	CaddyHandler,
	CaddyMatcherSet,
	CaddyReverseProxyHandler,
	CaddyRoute,
	CaddyServer,
	CaddyStaticIpSource,
} from './caddy'
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
