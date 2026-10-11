import { app } from '../../kit-fixture/src/app-kit'
import { ById, Deal } from '../../kit-fixture/src/schemas'

export const archive = app.group({ callers: ['human'] }, (r) => ({
	// mistake: the margin column goes out, which Deal does not declare; the error stays in this file, not at the mount
	get: r.query({ input: ById, output: Deal, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			const deal = await ctx.db.target.get()
			return { id: deal.id, title: deal.title, stage: deal.stage, margin: deal.margin }
		}),
}))
