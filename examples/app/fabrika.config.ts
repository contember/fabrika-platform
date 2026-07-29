import { defineApp, ServiceReference, Worker } from '@fabrika/provider-cloudflare'
import { exampleAppId, exampleAppSchema } from './propustka.schema'

export const buildExampleWorker = (): Worker =>
	new Worker({
		dir: '.',
		name: 'propustka-example-app',
		main: './src/index.ts',
		compatibility_flags: ['nodejs_compat_v2'],
		compatibility_date: '2025-10-01',
		observability: { enabled: true },
		// Path routes let the local multi-worker demo mount this app below the IAM surface.
		routes: ['*/demo', '*/demo/*'],
		bindings: {
			IAM: new ServiceReference('propustka-worker'),
		},
		vars: {
			DEV: 'true',
			PROPUSTKA_ISSUER: 'http://localhost:18191',
		},
	})

export default defineApp({
	id: exampleAppId,
	resources: buildExampleWorker,
	schema: exampleAppSchema,
	pipeline: {
		workerDir: '.',
	},
})
