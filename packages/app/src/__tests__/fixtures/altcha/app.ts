// The ALTCHA fixture's implementation. Each call makes its own `scoped(tables)`, because `boot` binds a layer once.

import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from './fabrika.contract'
import { tables } from './src/db/tables'

export function altchaApp() {
	return serve(contract, { database: scoped(tables) })
}
