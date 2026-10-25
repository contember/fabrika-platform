import { app } from '../kit-fixture/src/app-kit'

export const remind = app.cron('0 * * * *', { actions: ['crm.read'], kicks: ['close'] }).handle(({ ctx }) => {
	ctx.kick('close')
	ctx.kick('close', { at: new Date(Date.now() + 60_000) })
	// mistake: a kick carries nothing but its time; the job reads its rows
	ctx.kick('close', { at: new Date(), dealId: 'd1' })
})
