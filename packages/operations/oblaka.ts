import { define, type Worker } from '@fabrika/provider-cloudflare'
import { buildOperationsWorker } from './fabrika.config'

const operationsDefinition: (config: { env: string }) => Worker | undefined = define(
	({ env }) => buildOperationsWorker({ env, domain: process.env['OPERATIONS_HOSTNAME'] }),
)

export default operationsDefinition
