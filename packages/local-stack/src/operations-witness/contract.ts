// The witness's contract: the smallest one that keeps it a signed-in person's page. Its SPA row admits any member
// (any permission of `sdk-witness`), and the health check stays anonymous for the platform's probe.

import { compileContract, defineContract, schemaFromContract } from '@fabrika/app/contract'

export const witnessContract = compileContract(
	defineContract({
		app: 'sdk-witness',
		dimensions: {},
		actions: { 'witness.capture': 'Send the marked SDK exception' },
		roles: {},
	}, (c) => ({
		health: c.health('/healthz'),
		page: c.spa('/', { dir: 'dist', access: { member: true } }),
	})),
	{},
)

/** The IAM schema the witness registers: the one its contract compiles to. */
export const WITNESS_SCHEMA = schemaFromContract(witnessContract)
