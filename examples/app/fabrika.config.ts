import { appEnvironmentId } from '@fabrika/auth-core'
import { createCloudflareProxyWorker, defineApp, iamServiceReference, type ResourceContext, Worker } from '@fabrika/provider-cloudflare'
import { exampleGates } from './fabrika.gates'
import { exampleAppId, exampleAppSchema } from './fabrika.schema'

export const buildExampleWorker = (): Worker =>
	new Worker({
		dir: '.',
		name: 'propustka-example-app',
		main: './src/index.ts',
		compatibility_flags: ['nodejs_compat_v2'],
		compatibility_date: '2025-10-01',
		observability: { enabled: true },
		workers_dev: false,
		preview_urls: false,
		// Public routing belongs to the proxy Worker. The application is reached through its APP service binding.
		routes: [],
		bindings: {
			// IAM's application entrypoint: token verification, the people directory, audit. No key issuing.
			IAM: iamServiceReference(),
		},
		// No `FABRIKA_IAM_ISSUER` or `FABRIKA_IAM_APP_ID` here: the platform owns both and every deploy writes them into this Worker's
		// environment (ADR-0035). Declaring it would be REFUSED, because an app that names its own issuer
		// can point itself at a different one.
	})

/**
 * The proxy + app composition for a local run (`oblaka.ts`, lopata). A deploy never takes it: the config hands the
 * platform its gates, and the deployer builds the proxy Worker from its own copy (ADR-0048).
 */
export const buildExampleProxy = (ctx: ResourceContext): Worker =>
	createCloudflareProxyWorker({
		name: 'propustka-example-proxy',
		app: buildExampleWorker(),
		// The proxy mints for this environment's IAM application id; the deploy writes the same id into
		// the app Worker as FABRIKA_IAM_APP_ID, the audience it verifies.
		appId: appEnvironmentId(exampleAppId, ctx.env),
		appHost: ctx.domain ?? 'localhost',
		domain: ctx.domain,
		gates: exampleGates,
		iamUrl: process.env.FABRIKA_IAM_ISSUER ?? 'http://localhost:18191',
	})

export default defineApp({
	id: exampleAppId,
	resources: buildExampleWorker,
	gates: exampleGates,
	schema: exampleAppSchema,
	pipeline: {
		workerDir: '.',
	},
})
