// @fabrika/proxy — the Caddy deployment of the enforcement decision: the configuration that fronts
// the decision service, and the Bun process that serves it.
//
// The decision itself is `@fabrika/proxy-core`, shared verbatim with the Cloudflare proxy Worker.
// This package is private because it is an ARTIFACT, not an API — `bun run build` compiles
// `src/main.ts` into a static musl binary and bakes `caddy.json` beside it. Nothing outside this
// repository should import it; a consumer that needs the decision imports the core.

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
