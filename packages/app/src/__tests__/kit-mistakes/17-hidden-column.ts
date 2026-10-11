import { app } from '../kit-fixture/src/app-kit'
import { ById, Margin } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	margin: r.query({ input: ById, output: Margin, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			const deal = await ctx.db.target.get()
			// mistake: margin declares its own read action, deals.write, which a crm.read capability does not hold
			const margin: number | null = deal.margin
			return { margin }
		}),
}))
