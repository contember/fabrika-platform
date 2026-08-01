import { define, type Worker } from '@fabrika/provider-cloudflare'
import { buildOperationsProxy } from './fabrika.config'

const operationsDefinition: (config: { env: string }) => Worker | undefined = define(
	({ env }) => buildOperationsProxy({ env, domain: process.env['OPERATIONS_HOSTNAME'] }),
)

export default operationsDefinition
