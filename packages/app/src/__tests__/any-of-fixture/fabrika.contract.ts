// One endpoint for several actions: an `anyOf` endpoint admits a caller holding any listed action as a global grant.

import { app } from './src/app-kit'
import { cash } from './src/cash/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { cash }),
}))
