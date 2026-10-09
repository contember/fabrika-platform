// The cheap-tier variant: one runtime that claims the namespace-owned `postgres` service instead of its own. The
// platform generates the application's database URL from that claim, so zerops.yaml is the same file.

import { schemaFromContract } from '@fabrika/app/contract'
import { defineApp, useSharedPostgres as sharedPostgres } from '@fabrika/provider-zerops'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { NOTES_APP_ID, NOTES_SERVICE, NOTES_UPSTREAM, notesContract, notesRuntime } from './fabrika.config'

export default defineApp({
	id: NOTES_APP_ID,
	schema: schemaFromContract(notesContract),
	target: {
		platform: 'zerops',
		services: () => [notesRuntime],
		contract: notesContract,
		proxy: { upstream: NOTES_UPSTREAM, ...contractProxyTable(notesContract) },
		namespaceResources: [sharedPostgres()],
		deployService: NOTES_SERVICE,
		zeropsSetup: NOTES_SERVICE,
	},
})
