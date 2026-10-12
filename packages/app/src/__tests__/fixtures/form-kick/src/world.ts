// What the welcome job reaches outside the application, built by `defineDeps` at each boot. A test registers its own
// world and names it in the boot's environment, then counts runs and holds one at either hook.

import { defineDeps } from '@fabrika/app/implement'

export interface SignupWorld {
	/** Each run, before it reads: `principal` is the job's own. */
	started(run: { readonly principal: string; readonly runId: string }): Promise<void>
	/** Inside the run's transaction, after it took the inbox and before it commits. */
	taken(emails: readonly string[]): Promise<void>
	/** Once the run's transaction committed. */
	welcomed(emails: readonly string[]): void
}

/** The application variable that names a boot's world. */
export const WORLD_VARIABLE = 'SIGNUP_WORLD'

const worlds = new Map<string, SignupWorld>()

/** Registers `world` and answers the value of `WORLD_VARIABLE` that names it. */
export function registerWorld(world: SignupWorld): string {
	const id = Bun.randomUUIDv7()
	worlds.set(id, world)
	return id
}

export const signupDeps = defineDeps((env) => {
	const id = env[WORLD_VARIABLE]
	const world = typeof id === 'string' ? worlds.get(id) : undefined
	if (world === undefined) {
		throw new Error(`${WORLD_VARIABLE} names no registered world`)
	}
	return world
})
