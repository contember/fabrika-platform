import { app } from '../kit-fixture/src/app-kit'
import { ById, Deal } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: Deal, access: { action: 'crm.read', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			// mistake: a query cannot lock; the precondition read belongs in a mutation
			const deal = await ctx.db.target.getForUpdate()
			return { id: deal.id, title: deal.title, stage: deal.stage }
		}),
}))
