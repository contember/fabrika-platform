// What the jobs reach outside the application: an outbox standing in for the e-mail provider, and what the erase job
// removed. A test registers its own world and names it in the boot's environment.

import { defineDeps } from '@fabrika/app/implement'

export interface Mail {
	readonly note: string
	readonly attachments: readonly { readonly name: string | null; readonly type: string; readonly bytes: Uint8Array }[]
}

export interface FilesWorld {
	readonly sent: Mail[]
	/** How many file rows the erase job deleted, per table and note. */
	readonly removed: number[]
	/** Makes the erase job throw inside its transaction, after it deleted the rows. */
	failErase: boolean
}

/** The application variable that names a boot's world. */
export const WORLD_VARIABLE = 'FILES_WORLD'

const worlds = new Map<string, FilesWorld>()

export function registerWorld(world: FilesWorld): string {
	const id = Bun.randomUUIDv7()
	worlds.set(id, world)
	return id
}

export const filesDeps = defineDeps((env) => {
	const id = env[WORLD_VARIABLE]
	const world = typeof id === 'string' ? worlds.get(id) : undefined
	if (world === undefined) {
		throw new Error(`${WORLD_VARIABLE} names no registered world`)
	}
	return world
})
