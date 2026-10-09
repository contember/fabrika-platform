// The smoke application's access surface: a health endpoint, so the executor deploys it as every application is
// deployed, behind the proxy built from its contract.

import { defineContract } from '@fabrika/app/contract'

export const contract = defineContract({ app: 'smoke-app', dimensions: {}, actions: {}, roles: {} }, (c) => ({
	health: c.health('/healthz'),
}))
