// The welcome job: drains the signups in one transaction. The `signup` and `apply` procedures kick it, so a visitor is
// welcomed within seconds; its schedule picks up whatever a kicked run left.

import { app } from './app-kit'
import { Welcomed } from './schemas'
import { signupDeps } from './world'

export const welcome = app.cron('* * * * *', { actions: ['signups.process'], retries: 0, sql: 'write' }).handle(async ({ ctx }) => {
	const world = signupDeps.get()
	await world.started({ principal: ctx.principal.id, runId: ctx.runId })
	const welcomed = await ctx.transaction(async (tx) => {
		const rows = await tx.sql(Welcomed)`delete from signups returning email`
		await world.taken(rows.map((row) => row.email))
		return rows
	})
	world.welcomed(welcomed.map((row) => row.email))
})
