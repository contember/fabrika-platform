import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'

/** A fresh implementation: `scoped(tables)` binds to one boot. */
export function signupApp() {
	return serve(contract, { database: scoped(tables) })
}
