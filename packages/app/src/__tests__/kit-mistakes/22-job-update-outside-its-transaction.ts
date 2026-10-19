import { app } from '../kit-fixture/src/app-kit'

export const close = app.cron('0 * * * *', { actions: ['deals.write'] })
	.handle(async ({ ctx }) => {
		const deal = await ctx.ref('deals.write', 'deal', 'id')
		// mistake: a job writes inside ctx.transaction, where its lease fences the write
		await ctx.db.on(deal).update({ stage: 'won' }, { expectVersion: 1 })
	})
