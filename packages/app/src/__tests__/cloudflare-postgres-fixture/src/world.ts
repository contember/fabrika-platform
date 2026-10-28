// What the job reaches outside the application: the runs it records, and a run a test holds. A test registers its own
// world and names it in the environment.

import { defineDeps } from '@fabrika/app/implement'

export interface CfpgWorld {
	/** Each run of `tally` and the notes it counted. */
	readonly runs: { readonly job: string; readonly notes: number }[]
	/** Awaited by each run before it counts: a test holds a run here. */
	hold?: () => Promise<void>
}

/** The application variable that names a boot's world. */
export const WORLD_VARIABLE = 'CFPG_WORLD'

const worlds = new Map<string, CfpgWorld>()

export function registerWorld(world: CfpgWorld): string {
	const id = crypto.randomUUID()
	worlds.set(id, world)
	return id
}

export const cfpgDeps = defineDeps((env) => {
	const id = env[WORLD_VARIABLE]
	const world = typeof id === 'string' ? worlds.get(id) : undefined
	if (world === undefined) {
		throw new Error(`${WORLD_VARIABLE} names no registered world`)
	}
	return world
})
