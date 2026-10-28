import { type ContractImplementation, serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'
import { cfpgDeps, type CfpgWorld, registerWorld, WORLD_VARIABLE } from './world'

export interface CfpgApp {
	readonly implementation: ContractImplementation<typeof contract>
	/** The application variables a boot of `implementation` takes: the one that names its world. */
	readonly variables: Readonly<Record<string, string>>
}

/** A fresh implementation (`scoped(tables)` binds to one boot) whose boots reach `world`. */
export function cfpgApp(world: CfpgWorld): CfpgApp {
	return { implementation: serve(contract, { database: scoped(tables), deps: cfpgDeps }), variables: { [WORLD_VARIABLE]: registerWorld(world) } }
}
