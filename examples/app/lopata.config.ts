// Standalone run of the Cloudflare proxy, private example app, and IAM Worker. This exercises the
// public proxy→IAM and proxy→app service-binding paths in isolation.
//
// For the FULL demo — the admin UI plus this app sharing one local D1 — run `bun run dev` from
// `packages/iam` instead (its lopata.config.ts wires the proxy and app as auxiliaries).
export default {
	main: '../../packages/provider-cloudflare/src/wrangler.jsonc',
	workers: [
		{
			name: 'propustka-example-app',
			config: 'wrangler.jsonc',
		},
		{
			name: 'propustka-worker',
			config: '../../packages/iam/wrangler.jsonc',
		},
	],
}
