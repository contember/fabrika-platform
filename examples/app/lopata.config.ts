// Standalone run of just this example app, with the IAM Worker as an auxiliary worker, to
// exercise the app→IAM RPC path in isolation (the IAM SDK minting/verifying tokens over
// the `env.IAM` binding).
//
// For the FULL demo — the admin UI plus this app sharing one local D1 — run `bun run dev` from
// `packages/iam` instead (its lopata.config.ts runs this app as an auxiliary at `/demo`).
export default {
	main: 'wrangler.jsonc',
	workers: [
		{
			name: 'propustka-worker',
			config: '../../packages/iam/wrangler.jsonc',
		},
	],
}
