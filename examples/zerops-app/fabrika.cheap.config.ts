import { defineApp, useSharedPostgres as sharedPostgres, type ZeropsResourceContext, type ZeropsServiceSpec } from '@fabrika/provider-zerops'
import { NOTES_SERVICE, NOTES_UPSTREAM } from './fabrika.config'
import { notesGates } from './fabrika.gates'
import { NOTES_APP_ID, notesSchema } from './fabrika.schema'

/** Cheap-tier variant: the runtime consumes the namespace-owned `postgres` service. */
const services = (_ctx: ZeropsResourceContext): ZeropsServiceSpec[] => [{
	hostname: NOTES_SERVICE,
	type: 'alpine/bun@1.3',
	priority: 10,
	enableSubdomainAccess: false,
	minContainers: 1,
	maxContainers: 4,
}]

export default defineApp({
	id: NOTES_APP_ID,
	schema: notesSchema,
	pipeline: {
		secrets: ['NOTES_SESSION_PEPPER', 'NOTES_WEBHOOK_SIGNING_KEY'],
	},
	target: {
		platform: 'zerops',
		services,
		proxy: {
			upstream: NOTES_UPSTREAM,
			gates: notesGates,
		},
		namespaceResources: [sharedPostgres()],
		deployService: NOTES_SERVICE,
		zeropsSetup: NOTES_SERVICE,
	},
})
