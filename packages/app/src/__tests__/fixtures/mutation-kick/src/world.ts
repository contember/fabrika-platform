// What the deliver job reaches outside the application, built by `defineDeps` at each boot. A test registers its own
// world and names it in the boot's environment, then counts runs and holds one before it reads.

import { defineDeps } from '@fabrika/app/implement'

export interface OutboxWorld {
	/** Each run, before it reads: `principal` is the job's own, `signal` the run's. */
	started(run: { readonly principal: string; readonly runId: string; readonly signal: AbortSignal }): Promise<void>
	/** Once the run's transaction committed. */
	delivered(bodies: readonly string[]): void
}

/** The application variable that names a boot's world. */
export const WORLD_VARIABLE = 'OUTBOX_WORLD'

const worlds = new Map<string, OutboxWorld>()

/** Registers `world` and answers the value of `WORLD_VARIABLE` that names it. */
export function registerWorld(world: OutboxWorld): string {
	const id = Bun.randomUUIDv7()
	worlds.set(id, world)
	return id
}

export const outboxDeps = defineDeps((env) => {
	const id = env[WORLD_VARIABLE]
	const world = typeof id === 'string' ? worlds.get(id) : undefined
	if (world === undefined) {
		throw new Error(`${WORLD_VARIABLE} names no registered world`)
	}
	return world
})
