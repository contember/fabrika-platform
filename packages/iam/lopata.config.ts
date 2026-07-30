// Local dev / combined demo. Runs the IAM Worker (this package — the MAIN worker: serves native
// auth, JWKS, and the `/admin/*` JSON API) together with the example app as an AUXILIARY worker
// mounted at its `/demo` route. Both run in one process against one local D1, so the example's
// `iam.audit()` writes land in the same database the Fabrika console reads.
//
// The auxiliary entry is a local-dev convenience only; nothing in the worker's code depends on
// the example. Remove the `workers` array to run the IAM Worker on its own.
export default {
	main: './wrangler.jsonc',
	cron: false,
	workers: [
		{
			name: 'propustka-example-app',
			config: '../../examples/app/wrangler.jsonc',
		},
	],
}
