// The example application's whole access surface: who may call what. The proxy enforces it from the endpoint table
// the deployer compiles out of this file; each endpoint carries its handler (`src/access/endpoints.ts`).

import { access } from './src/access/endpoints'
import { app } from './src/app-kit'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', access),
	health: c.health('/healthz'),
}))
