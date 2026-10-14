// What the jobs reach outside the application: an outbox standing in for the e-mail provider, and where a job puts
// what `ctx.files` refused it. A test registers its own world and names it in the boot's environment.

import { defineDeps } from '@fabrika/app/implement'

export interface Mail {
	readonly note: string
	readonly attachments: readonly { readonly name: string | null; readonly type: string; readonly bytes: Uint8Array }[]
}

export interface Refusal {
	readonly step: string
	readonly error: unknown
}

export interface FilesWorld {
	readonly sent: Mail[]
	readonly refusals: Refusal[]
	/** How many files each `removeAll` of the erase job removed. */
	readonly removed: number[]
	/** Makes the erase job throw inside its transaction, after it removed the files. */
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
