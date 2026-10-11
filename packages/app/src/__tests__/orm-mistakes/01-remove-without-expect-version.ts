import { app } from '../kit-fixture/src/app-kit'
import { ById, Ok } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	drop: r.mutation({ input: ById, output: Ok, access: { action: 'crm.delete', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			// mistake: deals has a version column, so a remove names the version it read
			await ctx.db.target.remove()
			return { ok: true }
		}),
}))
