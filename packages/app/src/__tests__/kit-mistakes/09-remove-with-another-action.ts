import { app } from '../kit-fixture/src/app-kit'
import { ReopenDeal, Saved } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	drop: r.mutation({ input: ReopenDeal, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ input, ctx }) => {
			// mistake: removing a deal takes its delete action, crm.delete, not deals.write
			await ctx.db.target.remove({ expectVersion: input.expectVersion })
			return { id: input.expectVersion.toString(), version: 0 }
		}),
}))
