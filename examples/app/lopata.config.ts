// Standalone run of the Cloudflare proxy, private example app, and IAM Worker. This exercises the
// public proxy→IAM and proxy→app service-binding paths in isolation, and the app Worker's hop to its
// Durable Object (ADR-0065).
//
// For the FULL demo — the admin UI plus this app sharing one local D1 — run `bun run dev` from
// `packages/iam` instead (its lopata.config.ts wires the proxy and app as auxiliaries).
export default {
	main: '../../packages/provider-cloudflare/src/wrangler.jsonc',
	workers: [
		{
			name: 'propustka-example-app',
			config: 'wrangler.jsonc',
			// Local only: a deployed application Worker has no route, so this host stands in for a request that skips the
			// proxy, which the application must refuse.
			hosts: ['app.localhost'],
		},
		{
			name: 'propustka-worker',
			config: '../../packages/iam/wrangler.jsonc',
			// Local only: IAM's own surface (`/admin/*`, `/auth/*`), which the e2e witness provisions over.
			hosts: ['iam.localhost'],
		},
	],
}
