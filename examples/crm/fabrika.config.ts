import { compileContract, schemaFromContract } from '@fabrika/app/contract'
import { defineApp, type ZeropsServiceSpec } from '@fabrika/provider-zerops'
import { contractProxyTable } from '@fabrika/proxy-core/manifest'
import { contract } from './fabrika.contract'
import { tables } from './src/db/tables'

export const CRM_SERVICE = 'crmapi'
export const crmContract = compileContract(contract, tables)

const services = (): ZeropsServiceSpec[] => [
	{ hostname: 'crmdb', type: 'postgresql:single@18', profile: 'oltp-hobby', priority: 100 },
	{ hostname: 'crmfiles', type: 'object-storage', objectStorageSize: 1, priority: 50 },
	{ hostname: CRM_SERVICE, type: 'alpine/bun@1.3', priority: 10, enableSubdomainAccess: false, minContainers: 1, maxContainers: 2 },
]

export default defineApp({
	id: contract.vocabulary.app,
	schema: schemaFromContract(crmContract),
	target: {
		platform: 'zerops',
		services,
		contract: crmContract,
		proxy: { upstream: `${CRM_SERVICE}:3000`, ...contractProxyTable(crmContract) },
		deployService: CRM_SERVICE,
		zeropsSetup: CRM_SERVICE,
	},
})
