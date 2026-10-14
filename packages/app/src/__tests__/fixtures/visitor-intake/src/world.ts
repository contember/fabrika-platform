// What the intake job reaches outside the application: the e-mail provider and its public origin, built by
// `defineDeps` at each boot. A test registers its own world and names it in the boot's environment, and stops a run
// between two effects through `after`.

import { defineDeps } from '@fabrika/app/implement'

/** The effects of one delivery, in order: each is recorded in the candidate's row before the next one starts. */
export type DeliveryStep = 'revoked' | 'issued' | 'recorded' | 'mailed'

/** One e-mail; the provider sends one message per `idempotencyKey`, however often it is handed over. */
export interface IntakeMail {
	readonly to: string
	readonly url: string
	readonly idempotencyKey: string
}

export interface IntakeWorld {
	readonly origin: string
	/** Sends one e-mail; it throws when the provider refuses, and abandons the request once `signal` aborts. */
	send(message: IntakeMail, signal: AbortSignal): Promise<void>
	/** Runs after each effect of a delivery: a test throws here to stop the run between two effects. */
	after(step: DeliveryStep, candidate: string): Promise<void>
}

/** The application variable that names a boot's world. */
export const WORLD_VARIABLE = 'INTAKE_WORLD'

const worlds = new Map<string, IntakeWorld>()

/** Registers `world` and answers the value of `WORLD_VARIABLE` that names it. */
export function registerWorld(world: IntakeWorld): string {
	const id = Bun.randomUUIDv7()
	worlds.set(id, world)
	return id
}

export const intakeDeps = defineDeps((env) => {
	const id = env[WORLD_VARIABLE]
	const world = typeof id === 'string' ? worlds.get(id) : undefined
	if (world === undefined) {
		throw new Error(`${WORLD_VARIABLE} names no registered world`)
	}
	return world
})
