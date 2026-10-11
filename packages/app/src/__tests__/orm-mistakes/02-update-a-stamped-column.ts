import { app } from '../kit-fixture/src/app-kit'
import { ReopenDeal, Saved } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	bump: r.mutation({ input: ReopenDeal, output: Saved, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ input, ctx }) =>
			// mistake: the layer stamps the version; an update names only the columns the policy lists
			ctx.db.target.update({ version: input.expectVersion + 1 }, { expectVersion: input.expectVersion })
		),
}))
