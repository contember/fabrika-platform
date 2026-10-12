// A kit application for the member lookup below a directory (`members-lookup.test.ts`, and its generated tests).

import { app } from './src/app-kit'
import { deals } from './src/deals/endpoints'

export const contract = app.contract((c) => ({ api: c.rpc('/api', { deals }), health: c.health('/healthz') }))
