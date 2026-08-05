import { createCloudflareProxyWorker, defineApp, type ResourceContext, ServiceReference, Worker } from '@fabrika/provider-cloudflare'
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
		// Public routing belongs to the proxy Worker. The application is reached through its APP service binding.
		routes: [],
		bindings: {
			IAM: new ServiceReference('propustka-worker'),
		},
		vars: {
			FABRIKA_IAM_ISSUER: process.env.FABRIKA_IAM_URL ?? 'http://localhost:18191',
		},
	})

export const buildExampleProxy = (ctx: ResourceContext): Worker =>
	createCloudflareProxyWorker({
		name: 'propustka-example-proxy',
		app: buildExampleWorker(),
		appId: exampleAppId,
		appHost: ctx.domain ?? 'localhost',
		domain: ctx.domain,
		gates: exampleGates,
		iamUrl: process.env.FABRIKA_IAM_URL ?? 'http://localhost:18191',
	})

export default defineApp({
	id: exampleAppId,
	resources: buildExampleProxy,
	schema: exampleAppSchema,
	pipeline: {
		workerDir: '.',
	},
})
