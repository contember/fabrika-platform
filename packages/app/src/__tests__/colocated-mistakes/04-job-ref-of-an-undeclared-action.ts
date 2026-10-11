import { app } from '../kit-fixture/src/app-kit'

export const sweep = app.cron('0 3 * * *', { actions: ['crm.read'], scope: 'app' })
	.handle(async ({ ctx }) => {
		// mistake: the job declares crm.read only
		await ctx.ref('crm.delete', 'deal', 'x')
	})
