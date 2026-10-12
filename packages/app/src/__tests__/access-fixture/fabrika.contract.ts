// A kit application for the endpoint access kit's own cases (`endpoint-access.test.ts`).

import { app } from './src/app-kit'
import { notes, purge, shared } from './src/notes/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	shared,
	health: c.health('/healthz'),
	jobs: { purge },
}))
