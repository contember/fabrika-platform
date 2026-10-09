// The deploy surface on Zerops: three services in the project the registry names, and the compiled contract. The
// contract locks the setup down (ADR-0043): the platform generates the run section, so zerops.yaml keeps only the
// build base. The proxy serves the contract's endpoint table and IAM reconciles the schema it compiles to.
//
// Not here: `project` (the project id is a registry field, ADR-0006) and `pipeline.vars` (the app needs none; the
// platform writes every `FABRIKA_*` variable, ADR-0035).

import { compileContract, schemaFromContract } from '@fabrika/app/contract'
import { defineApp, type ZeropsResourceContext, type ZeropsServiceSpec } from '@fabrika/provider-zerops'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { contract } from './fabrika.contract'
import { tables } from './src/db/tables'

/** The runtime service, which the code deploys to. Also the `zerops.yaml` setup name. */
export const NOTES_SERVICE = 'notesapi'
/** Its database, reached over the project's private network only. */
export const NOTES_DATABASE_SERVICE = 'notesdb'
/** The bucket of the `attachments` collection; the platform hands the runtime `FABRIKA_APP_STORAGE_*` from it. */
export const NOTES_FILES_SERVICE = 'notesfiles'
/** The port the generated entrypoint listens on; the proxy dials it once a request passes the endpoint table. */
export const NOTES_UPSTREAM = `${NOTES_SERVICE}:3000`

/** The IAM application id; a token's `aud` is `notes@<env>`. */
export const NOTES_APP_ID = contract.vocabulary.app

export const notesContract = compileContract(contract, tables)

/** One private bucket; the platform refuses any other policy. Shared by the cheap-tier variant. */
export const notesFiles: ZeropsServiceSpec = {
	hostname: NOTES_FILES_SERVICE,
	type: 'object-storage',
	objectStorageSize: 1,
	priority: 50,
}

/** The runtime, shared by the cheap-tier variant. Lowercase letters and digits only, at most 25 (Zerops). */
export const notesRuntime: ZeropsServiceSpec = {
	hostname: NOTES_SERVICE,
	type: 'alpine/bun@1.3',
	priority: 10,
	// Not public: the proxy is the only publicly routed service, and the platform refuses `true`.
	enableSubdomainAccess: false,
	minContainers: 1,
	maxContainers: 4,
}

const services = (_ctx: ZeropsResourceContext): ZeropsServiceSpec[] => [
	{
		hostname: NOTES_DATABASE_SERVICE,
		// One node on every environment: availability is the type, so HA later is a new service and a migration.
		type: 'postgresql:single@18',
		// Without a profile a single service gets `oltp-staging`; `oltp-hobby` is the cheapest floor.
		profile: 'oltp-hobby',
		// Created before the runtime, whose start script migrates into it.
		priority: 100,
	},
	notesFiles,
	notesRuntime,
]

export default defineApp({
	id: NOTES_APP_ID,
	schema: schemaFromContract(notesContract),
	target: {
		platform: 'zerops',
		services,
		contract: notesContract,
		proxy: { upstream: NOTES_UPSTREAM, ...contractProxyTable(notesContract) },
		// Required with more than one service: the code deploys to this one.
		deployService: NOTES_SERVICE,
		zeropsSetup: NOTES_SERVICE,
	},
})
