import { app } from '../kit-fixture/src/app-kit'
import { Deal, ReopenDeal } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	reopen: r.mutation({ input: ReopenDeal, output: Deal, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			const saved = await ctx.db.target.update({ stage: 'proposal' }, { expectVersion: input.expectVersion })
			// mistake: a write answers the key and the new version, never the row
			return { id: saved.id, title: saved.title, stage: 'proposal' as const }
		}),
}))
