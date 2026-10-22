// What the jobs reach outside the application: the runs they record. A test registers its own world and names it in
// the object's environment.

import { defineDeps } from '@fabrika/app/implement'

export interface NotesWorld {
	/** Each job run's name and the notes it counted. */
	readonly runs: { readonly job: string; readonly notes: number }[]
}

/** The application variable that names a boot's world. */
export const WORLD_VARIABLE = 'NOTES_WORLD'

const worlds = new Map<string, NotesWorld>()

export function registerWorld(world: NotesWorld): string {
	const id = crypto.randomUUID()
	worlds.set(id, world)
	return id
}

export const notesDeps = defineDeps((env) => {
	const id = env[WORLD_VARIABLE]
	const world = typeof id === 'string' ? worlds.get(id) : undefined
	if (world === undefined) {
		throw new Error(`${WORLD_VARIABLE} names no registered world`)
	}
	return world
})
