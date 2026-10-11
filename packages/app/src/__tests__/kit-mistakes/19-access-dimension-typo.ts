import { app } from '../kit-fixture/src/app-kit'
import { ById, Deal } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	get: r.query({
		input: ById,
		output: Deal,
		// mistake: the vocabulary names no dimension deall
		access: { action: 'crm.read', on: 'deall', from: 'id' },
	})
		.handle(async ({ ctx }) => {
			// follow-up: the handler's capability names the refused form instead of guessing another
			const deal = await ctx.db.target.get()
			return { id: deal.id, title: deal.title, stage: deal.stage }
		}),
}))
