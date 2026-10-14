import { app } from '../kit-fixture/src/app-kit'
import { ById, Saved } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	clear: r.query({ input: ById, output: Saved, access: { action: 'crm.delete', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			// mistake: a query reads only, so it removes no file
			await ctx.files('documents').removeAll(ctx.target)
			return { id: ctx.target.value, version: 1 }
		}),
}))
