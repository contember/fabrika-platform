import { type ContractImplementation, serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { tables } from '../../scoped-files/src/db/tables'
import { contract } from '../fabrika.contract'
import { filesDeps, type FilesWorld, registerWorld, WORLD_VARIABLE } from './world'

export interface FilesApp {
	readonly implementation: ContractImplementation<typeof contract>
	/** The application variables a boot of `implementation` takes: the one that names its world. */
	readonly variables: Readonly<Record<string, string>>
}

/** A fresh implementation (`scoped(tables)` binds to one boot) whose boots reach `world`. */
export function filesApp(world: FilesWorld): FilesApp {
	return { implementation: serve(contract, { database: scoped(tables), deps: filesDeps }), variables: { [WORLD_VARIABLE]: registerWorld(world) } }
}
