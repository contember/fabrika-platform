import type { ContractImplementation } from '@fabrika/app/implement'
import { serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'
import { registerWorld, signupDeps, type SignupWorld, WORLD_VARIABLE } from './world'

export interface SignupApp {
	readonly implementation: ContractImplementation
	/** The application variables a boot of `implementation` takes: the one that names its world. */
	readonly variables: Readonly<Record<string, string>>
}

/** A fresh implementation (`scoped(tables)` binds to one boot) whose boots reach `world`. */
export function signupApp(world: SignupWorld): SignupApp {
	return { implementation: serve(contract, { database: scoped(tables), deps: signupDeps }), variables: { [WORLD_VARIABLE]: registerWorld(world) } }
}
