import type { Ref } from '@fabrika/app/implement'
import { app } from '../kit-fixture/src/app-kit'

export const audit = app.cron('0 3 * * *', { actions: ['crm.read', 'deals.write'] })
	.handle(async ({ ctx }) => {
		const ref: Ref<'deal', 'crm.read' | 'deals.write'> = await ctx.ref('crm.read', 'deal', 'id')
		const deal = await ctx.db.on(ref).get()
		// mistake: a widened capability type proves no action, so the margin column stays hidden
		const margin: number | null = deal.margin
		console.info(margin)
	})
