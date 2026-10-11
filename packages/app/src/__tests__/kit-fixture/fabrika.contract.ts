import { app } from './src/app-kit'
import { companies } from './src/companies/endpoints'
import { deals } from './src/deals/endpoints'
import { pipeline } from './src/exports'
import { github } from './src/hooks'
import { close } from './src/jobs'
import { shared } from './src/shared'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { deals, companies }),
	shared,
	github,
	health: c.health('/healthz'),
	jobs: { close },
	exports: { pipeline },
}))
