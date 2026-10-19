// The deliver job: drains the outbox in one transaction. `enqueue` kicks it, so a message leaves within seconds; its
// schedule picks up whatever a kicked run left.

import { app } from './app-kit'
import { Delivered } from './schemas'
import { outboxDeps } from './world'

export const deliver = app.cron('* * * * *', { actions: ['outbox.read'], retries: 1, sql: 'write' }).handle(async ({ ctx }) => {
	const world = outboxDeps.get()
	await world.started({ principal: ctx.principal.id, runId: ctx.runId, signal: ctx.signal })
	const delivered = await ctx.transaction((tx) => tx.sql(Delivered)`delete from outbox returning body`)
	world.delivered(delivered.map((row) => row.body))
})

/** Kicks `deliver` once its own run succeeded, so a job edge starts the drain without waiting for its schedule. */
export const sweep = app.cron('0 * * * *', { actions: ['outbox.read'], kicks: ['deliver'] }).handle(({ ctx }) => {
	ctx.kick('deliver')
})
