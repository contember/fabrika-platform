// The intake fixture's implementation: forms run no handler, so it has none. Each call makes its own
// `scoped(tables)`, because `boot` binds a layer once.

import { scoped } from '@fabrika/db'
import { implement } from '../../../../implement/implement'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'

export function intakeApp() {
	return implement(contract, { database: scoped(tables), deps: () => ({}), handlers: () => ({}) })
}
