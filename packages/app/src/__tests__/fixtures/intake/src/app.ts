// The intake fixture's implementation. Each call makes its own `scoped(tables)`, because `boot` binds a layer once.

import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'

export function intakeApp() {
	return serve(contract, { database: scoped(tables) })
}
