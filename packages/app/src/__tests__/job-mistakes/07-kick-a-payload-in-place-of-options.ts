import { app } from '../kit-fixture/src/app-kit'

export const remind = app.cron('0 * * * *', { actions: ['crm.read'], kicks: ['close'] }).handle(({ ctx }) => {
	// mistake: the second argument is when the job runs, never what it works on
	ctx.kick('close', 'd1')
})
