import { type ContractImplementation, serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'
import { notesDeps, type NotesWorld, registerWorld, WORLD_VARIABLE } from './world'

export interface NotesApp {
	readonly implementation: ContractImplementation<typeof contract>
	/** The application variables a boot of `implementation` takes: the one that names its world. */
	readonly variables: Readonly<Record<string, string>>
}

/** A fresh implementation (`scoped(tables)` binds to one boot) whose boots reach `world`. */
export function notesApp(world: NotesWorld): NotesApp {
	return { implementation: serve(contract, { database: scoped(tables), deps: notesDeps }), variables: { [WORLD_VARIABLE]: registerWorld(world) } }
}
