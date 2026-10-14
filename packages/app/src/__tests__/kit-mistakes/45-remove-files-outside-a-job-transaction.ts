import { app } from '../kit-fixture/src/app-kit'

export const erase = app.cron('0 3 * * *', { actions: ['crm.delete'], scope: 'app' })
	.handle(async ({ ctx }) => {
		const deal = await ctx.ref('crm.delete', 'deal', 'd1')
		// mistake: a job removes files inside ctx.transaction, as tx.files
		await ctx.files('documents').removeAll(deal)
	})
