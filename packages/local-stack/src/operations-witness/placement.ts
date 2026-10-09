import type { AppGates, AppSchema } from '@fabrika/auth-core'

/** IAM's id of the witness: one environment, as the proxy mints for it and the witness verifies. */
export const WITNESS_IAM_APP_ID = 'sdk-witness@prod'
export const WITNESS_HOST = 'sdk.fabrika.localhost'
export const WITNESS_ORIGIN = `http://${WITNESS_HOST}:18081`
export const WITNESS_UPSTREAM = 'operations-witness:3000'

/** A signed-in person for every path but the platform's health probe. */
export const WITNESS_GATES: AppGates = {
	rules: [
		{ path: '/healthz', kind: 'public' },
		{ path: '/*', kind: 'human' },
	],
}

/** The first reconcile registers an application with IAM, so the witness declares the one action it stands for. */
export const WITNESS_SCHEMA: AppSchema = {
	scopes: [],
	actions: [{ action: 'witness.capture', description: 'Send the marked SDK exception' }],
	roles: {},
}
