// A kit application with public procedures (`public-procedure.test.ts`, and the static reader's tests).

import { app } from './src/app-kit'
import { catalog, intake, staff } from './src/intake/endpoints'

export const contract = app.contract((c) => ({ api: c.rpc('/api', { intake, catalog, staff }), health: c.health('/healthz') }))
