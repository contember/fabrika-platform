import { app } from '../../kit-fixture/src/app-kit'
import { ById, Deal } from '../../kit-fixture/src/schemas'

export const archive = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({ input: ById, output: Deal, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		// mistake: the margin goes out as the title, which Deal declares a string; the error stays in this file, not at the mount
		.handle(async ({ ctx }) => {
			const deal = await ctx.db.target.get()
			return { id: deal.id, title: deal.margin, stage: deal.stage }
		}),
}))
