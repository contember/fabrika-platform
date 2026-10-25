import { app } from '../kit-fixture/src/app-kit'

export const remind = app.cron('0 * * * *', { actions: ['crm.read'], kicks: ['close'] }).handle(({ ctx }) => {
	// mistake: at is a Date, not epoch milliseconds
	ctx.kick('close', { at: Date.now() + 60_000 })
})
