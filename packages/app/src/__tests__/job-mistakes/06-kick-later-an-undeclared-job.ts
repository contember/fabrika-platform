import { app } from '../kit-fixture/src/app-kit'

export const remind = app.cron('0 * * * *', { actions: ['crm.read'], kicks: ['close'] }).handle(({ ctx }) => {
	// mistake: a delayed kick names only the jobs its kicks lists
	ctx.kick('digest', { at: new Date(Date.now() + 60_000) })
})
